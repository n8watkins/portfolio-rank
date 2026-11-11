// Signed, expiring, one-time links (owner decision 2026-11-10: no account
// needed, a link plus an email gets a one-time link) and the report-owner
// cookie. Every one-time link the site emails is made and opened here, in
// one of two scopes:
//
//   grade-link   a graded job's report (/grade/<id>; the subject is the job
//                id). A report is shareable by its unguessable link; the
//                emailed link is more: it proves the person reads that
//                inbox, so opening it once makes this browser the report's
//                owner (it may delete the report and sees its own earlier
//                reports when re-grading). Valid 7 days.
//   report-link  a listed portfolio's printable report (app/report/print;
//                the subject is the portfolio's address), for visitors who
//                don't sign in (GAMES_V2). Valid 1 day.
//
// A link is a token "<payload>.<signature>": the payload names the subject,
// a random nonce and the expiry; the signature is an HMAC with AUTH_SECRET
// over the scope and the payload, so a token of one scope never opens the
// other. Only a hash of the nonce is stored (grade_links, whose job_id
// column holds the subject), and it is marked used on first open.
//
// The owner cookie (pr_grades) holds the ids of the reports this browser
// owns (the ones it requested, and any opened from an email), signed the
// same way, at most OWNER_MAX ids.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { JOB_ID } from "./jobs.mjs";

export const LINK_TTL_DAYS = 7;
export const OWNER_COOKIE = "pr_grades";
export const OWNER_MAX = 20;

/** What each scope's subject must look like, and how long its links last. */
export const LINK_SCOPES = {
  "grade-link": { subject: (s) => JOB_ID.test(s), ttlDays: LINK_TTL_DAYS },
  "report-link": { subject: (s) => s.length <= 2048 && /^https?:\/\/\S+$/.test(s), ttlDays: 1 },
};

const b64 = (s) => Buffer.from(s).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");
const sign = (secret, scope, data) => createHmac("sha256", String(secret)).update(`${scope}\n${data}`).digest("base64url");
const sameSig = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const nonceHash = (nonce) => createHash("sha256").update(nonce).digest("base64url");

function nonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function scopeOf(scope) {
  const rules = LINK_SCOPES[scope];
  if (!rules) throw new Error(`unknown link scope: ${scope}`);
  return rules;
}

/**
 * A new one-time link of `scope` for `subject` (stored as a nonce hash).
 * Returns { token, expiresAt }.
 */
export async function createOneTimeLink(db, { scope, subject, secret, now = Date.now(), ttlDays = scopeOf(scope).ttlDays }) {
  if (!secret) throw new Error("one-time links need AUTH_SECRET");
  if (!scopeOf(scope).subject(String(subject ?? ""))) throw new Error(`not a ${scope} subject`);
  const n = nonce();
  const e = now + ttlDays * 86400000;
  const payload = b64(JSON.stringify({ j: subject, n, e }));
  await db.execute({
    sql: "INSERT INTO grade_links (nonce_hash, job_id, expires_at, scope) VALUES (?, ?, ?, ?)",
    args: [nonceHash(n), subject, new Date(e).toISOString(), scope],
  });
  return { token: `${payload}.${sign(secret, scope, payload)}`, expiresAt: new Date(e).toISOString() };
}

/**
 * Opens a one-time link of `scope`. Returns { ok: true, subject } the first
 * time, or { ok: false, error: "bad" | "expired" | "used", subject? }.
 * Marking it used is atomic, so two clicks at once can't both pass.
 */
export async function openOneTimeLink(db, token, { scope, secret, now = Date.now() }) {
  const rules = scopeOf(scope);
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig || !secret || !sameSig(sig, sign(secret, scope, payload))) return { ok: false, error: "bad" };
  let data;
  try {
    data = JSON.parse(unb64(payload));
  } catch {
    return { ok: false, error: "bad" };
  }
  if (typeof data?.j !== "string" || !rules.subject(data.j) || typeof data?.n !== "string" || typeof data?.e !== "number") return { ok: false, error: "bad" };
  if (now > data.e) return { ok: false, error: "expired", subject: data.j };
  const r = await db.execute({
    sql: "UPDATE grade_links SET used_at = ? WHERE nonce_hash = ? AND job_id = ? AND scope = ? AND used_at IS NULL",
    args: [new Date(now).toISOString(), nonceHash(data.n), data.j, scope],
  });
  if (!r.rowsAffected) return { ok: false, error: "used", subject: data.j };
  return { ok: true, subject: data.j };
}

/** A new one-time link for a job's report. Returns { token, expiresAt }. */
export async function createLinkToken(db, { jobId, secret, now = Date.now(), ttlDays = LINK_TTL_DAYS }) {
  return createOneTimeLink(db, { scope: "grade-link", subject: jobId, secret, now, ttlDays });
}

/**
 * Opens a job report's one-time link. Returns { ok: true, jobId } the first
 * time, or { ok: false, error: "bad" | "expired" | "used", jobId? }.
 */
export async function openLinkToken(db, token, { secret, now = Date.now() }) {
  const r = await openOneTimeLink(db, token, { scope: "grade-link", secret, now });
  if (r.ok) return { ok: true, jobId: r.subject };
  return r.subject ? { ok: false, error: r.error, jobId: r.subject } : { ok: false, error: r.error };
}

/** The owner cookie's value for a list of job ids. */
export function ownerCookieValue(ids, secret) {
  const list = [...new Set(ids.filter((id) => JOB_ID.test(id)))].slice(-OWNER_MAX).join(",");
  const payload = b64(list);
  return `${payload}.${sign(secret, "grade-owner", payload)}`;
}

/** The job ids a signed owner cookie lists ([] when missing or forged). */
export function readOwnerCookie(value, secret) {
  const [payload, sig] = String(value ?? "").split(".");
  if (!payload || !sig || !secret || !sameSig(sig, sign(secret, "grade-owner", payload))) return [];
  return unb64(payload).split(",").filter((id) => JOB_ID.test(id));
}

/** Deletes link rows past their expiry (housekeeping). */
export async function pruneLinks(db, { now = Date.now() } = {}) {
  return (await db.execute({ sql: "DELETE FROM grade_links WHERE expires_at < ?", args: [new Date(now).toISOString()] })).rowsAffected;
}
