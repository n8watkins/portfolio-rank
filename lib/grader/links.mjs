// Signed, expiring, one-time links (owner decision 2026-11-10: no account
// needed, a link plus an email gets a one-time link) and the report-owner
// cookie.
//
// A report is shareable by its unguessable link (/grade/<id>). The emailed
// link is more: it proves the person reads that inbox, so opening it once
// makes this browser the report's owner (it may delete the report and sees
// its own earlier reports when re-grading). It is a token
// "<payload>.<signature>": the payload names the job, a random nonce and the
// expiry; the signature is an HMAC with AUTH_SECRET; only a hash of the
// nonce is stored, and it is marked used on first open.
//
// The owner cookie (pr_grades) holds the ids of the reports this browser
// owns (the ones it requested, and any opened from an email), signed the
// same way, at most OWNER_MAX ids.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { JOB_ID } from "./jobs.mjs";

export const LINK_TTL_DAYS = 7;
export const OWNER_COOKIE = "pr_grades";
export const OWNER_MAX = 20;

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

/** A new one-time link for a job's report (stored as a nonce hash). Returns { token, expiresAt }. */
export async function createLinkToken(db, { jobId, secret, now = Date.now(), ttlDays = LINK_TTL_DAYS }) {
  if (!secret) throw new Error("one-time links need AUTH_SECRET");
  const n = nonce();
  const e = now + ttlDays * 86400000;
  const payload = b64(JSON.stringify({ j: jobId, n, e }));
  await db.execute({
    sql: "INSERT INTO grade_links (nonce_hash, job_id, expires_at) VALUES (?, ?, ?)",
    args: [nonceHash(n), jobId, new Date(e).toISOString()],
  });
  return { token: `${payload}.${sign(secret, "grade-link", payload)}`, expiresAt: new Date(e).toISOString() };
}

/**
 * Opens a one-time link. Returns { ok: true, jobId } the first time, or
 * { ok: false, error: "bad" | "expired" | "used", jobId? }. Marking it used
 * is atomic, so two clicks at once can't both pass.
 */
export async function openLinkToken(db, token, { secret, now = Date.now() }) {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig || !secret || !sameSig(sig, sign(secret, "grade-link", payload))) return { ok: false, error: "bad" };
  let data;
  try {
    data = JSON.parse(unb64(payload));
  } catch {
    return { ok: false, error: "bad" };
  }
  if (!JOB_ID.test(String(data?.j ?? "")) || typeof data?.n !== "string" || typeof data?.e !== "number") return { ok: false, error: "bad" };
  if (now > data.e) return { ok: false, error: "expired", jobId: data.j };
  const r = await db.execute({
    sql: "UPDATE grade_links SET used_at = ? WHERE nonce_hash = ? AND job_id = ? AND used_at IS NULL",
    args: [new Date(now).toISOString(), nonceHash(data.n), data.j],
  });
  if (!r.rowsAffected) return { ok: false, error: "used", jobId: data.j };
  return { ok: true, jobId: data.j };
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
