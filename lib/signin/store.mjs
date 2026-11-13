// Email sign-in: one-time links and email accounts (lib/signin/schema.mjs).
//
// A link carries a 256-bit random token; the database keeps only its SHA-256,
// so a database read can't sign anyone in. A token lives TOKEN_TTL_MS and
// works once: it is consumed in one UPDATE ... RETURNING, so two clicks can't
// both sign in. The account behind an address is created at its first
// sign-in; its rater id is em:<id>, where <id> is random (never derived from
// the address), so the id says nothing about the person.
import { createHash, randomBytes } from "node:crypto";
import { addressHash, validEmail } from "../email/gate.mjs";

export const TOKEN_TTL_MS = 15 * 60 * 1000;
/** The rater id prefix of an email account. */
export const EMAIL_PREFIX = "em:";
export const isEmailAccount = (id) => String(id ?? "").startsWith(EMAIL_PREFIX);

const iso = (ms) => new Date(ms).toISOString();
const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

/** A token as it appears in a link: 43 base64url characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The address as stored and compared: trimmed and lower case, or null when it isn't one. */
export function normalizeEmail(raw) {
  const ok = validEmail(raw);
  return ok ? ok.toLowerCase() : null;
}

/** "na***@example.com": enough to recognise your own address, not to read someone else's. */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "";
  return `${local.slice(0, Math.min(2, local.length))}${"*".repeat(3)}@${domain}`;
}

/** Only same-site paths are followed after sign-in. */
export function safeCallback(raw) {
  const s = String(raw ?? "");
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.length > 500) return null;
  return s;
}

/**
 * Makes a one-time link token for `email` and drops expired or used ones.
 * Returns the token (only the caller ever sees it).
 * @param {any} db
 * @param {{ email: string, callback?: string | null, now?: number }} options
 */
export async function issueToken(db, { email, callback = null, now = Date.now() }) {
  const token = randomBytes(32).toString("base64url");
  await db.batch(
    [
      { sql: "DELETE FROM email_signin_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", args: [iso(now)] },
      {
        sql: "INSERT INTO email_signin_tokens (token_hash, email, callback, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        args: [hashToken(token), email, safeCallback(callback), iso(now), iso(now + TOKEN_TTL_MS)],
      },
    ],
    "write"
  );
  return token;
}

/**
 * What a link would do, without using it: { email, callback } while it is
 * good, else { error: "invalid" | "expired" | "used" }.
 */
export async function peekToken(db, token, { now = Date.now() } = {}) {
  if (!TOKEN_RE.test(String(token ?? ""))) return { error: "invalid" };
  const r = (await db.execute({ sql: "SELECT email, callback, expires_at, used_at FROM email_signin_tokens WHERE token_hash = ?", args: [hashToken(token)] })).rows[0];
  if (!r) return { error: "invalid" };
  if (r.used_at) return { error: "used" };
  if (String(r.expires_at) <= iso(now)) return { error: "expired" };
  return { email: String(r.email), callback: r.callback == null ? null : String(r.callback) };
}

/**
 * Uses a link: marks it used (once, atomically) and returns the account it
 * signs in, created on first use: { account: { id, email, createdAt }, callback }
 * or { error: "invalid" | "expired" | "used" }.
 * @param {any} db
 * @param {string} token
 * @param {{ now?: number, secret?: string }} [options]
 */
export async function consumeToken(db, token, { now = Date.now(), secret } = {}) {
  if (!TOKEN_RE.test(String(token ?? ""))) return { error: "invalid" };
  const used = (
    await db.execute({
      sql: "UPDATE email_signin_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, callback",
      args: [iso(now), hashToken(token), iso(now)],
    })
  ).rows[0];
  if (!used) {
    const peek = await peekToken(db, token, { now });
    return { error: "error" in peek ? peek.error : "used" };
  }
  const email = String(used.email);
  const row = (
    await db.execute({
      sql: `INSERT INTO email_accounts (id, email, email_hash, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(email_hash) DO UPDATE SET last_sign_in_at = excluded.last_sign_in_at
            RETURNING id, email, created_at`,
      args: [randomBytes(12).toString("base64url"), email, addressHash(email, secret), iso(now), iso(now)],
    })
  ).rows[0];
  return {
    account: { id: `${EMAIL_PREFIX}${row.id}`, email: String(row.email), createdAt: String(row.created_at) },
    callback: used.callback == null ? null : String(used.callback),
  };
}

/** Removes an email account and its pending links (account deletion, lib/account.mjs). */
export function deleteEmailAccountStatements(raterId) {
  const id = String(raterId).slice(EMAIL_PREFIX.length);
  return [
    { sql: "DELETE FROM email_signin_tokens WHERE email IN (SELECT email FROM email_accounts WHERE id = ?)", args: [id] },
    { sql: "DELETE FROM email_accounts WHERE id = ?", args: [id] },
  ];
}

/** The account row for an export (lib/account.mjs accountData). */
export async function emailAccountRow(db, raterId) {
  const id = String(raterId).slice(EMAIL_PREFIX.length);
  const r = (await db.execute({ sql: "SELECT email, created_at, last_sign_in_at FROM email_accounts WHERE id = ?", args: [id] })).rows[0];
  return r ? { email: String(r.email), createdAt: String(r.created_at), lastSignInAt: r.last_sign_in_at == null ? null : String(r.last_sign_in_at) } : null;
}

/** Retention: links that expired more than a day ago or were used. */
export async function pruneTokens(db, { now = Date.now() } = {}) {
  const r = await db.execute({ sql: "DELETE FROM email_signin_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", args: [iso(now - 24 * 60 * 60 * 1000)] });
  return r.rowsAffected;
}
