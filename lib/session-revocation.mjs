// Ending sessions before they run out (auth.ts). Sessions are signed
// cookies (JWTs, 30 days), so nothing server-side lists them; instead each
// account can have a "revoked at" time, and a session signed in at or
// before it is signed out the next time it is read:
//
//   "Sign out everywhere" (/settings, POST /api/account/sessions)
//   deleting the account (DELETE /api/account)
//
// The admin's session also ends ADMIN_SESSION_MS after sign-in, however
// recently it was used, so a lost admin cookie is worth half a day at most.
//
// A session's sign-in time is the "at" claim (milliseconds) written at
// sign-in; a session from before the claim existed uses its issue time
// (iat) from then on.
//
// Each isolate keeps an account's revoked time for REVOCATION_TTL_MS, so a
// signed-in page view costs no extra query most of the time; a revocation
// reaches every isolate within that time, and the one that wrote it at once.

export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
export const REVOCATION_TTL_MS = 60 * 1000;

export const SESSION_TABLES = [
  // One row per account that ended its sessions: sessions signed in at or
  // before revoked_at (ms) are signed out. No other data about the account.
  `CREATE TABLE IF NOT EXISTS session_revocations (
    rater_id TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL
  )`,
];

/** When this session signed in (ms): its "at" claim, else its issue time. */
export function signedInAt(token) {
  const at = Number(token?.at);
  if (Number.isFinite(at) && at > 0) return at;
  const iat = Number(token?.iat);
  return Number.isFinite(iat) && iat > 0 ? iat * 1000 : null;
}

/**
 * Whether a session may go on. `revokedAt` is the account's revoked time
 * (ms) or null; `isAdmin` whether the session is the admin's.
 * @param {Record<string, unknown> | null | undefined} token
 * @param {{ revokedAt: number | null, isAdmin: boolean, now: number }} options
 */
export function sessionValid(token, { revokedAt, isAdmin, now }) {
  const at = signedInAt(token);
  if (at == null) return revokedAt == null && !isAdmin;
  if (revokedAt != null && at <= revokedAt) return false;
  if (isAdmin && now - at > ADMIN_SESSION_MS) return false;
  return true;
}

const memo = new Map();

/** The account's revoked time (ms), or null; memoized per isolate for REVOCATION_TTL_MS. Throws on a database error. */
export async function revokedAt(db, raterId, { now = Date.now() } = {}) {
  const hit = memo.get(raterId);
  if (hit && now - hit.read < REVOCATION_TTL_MS) return hit.revokedAt;
  const row = (await db.execute({ sql: "SELECT revoked_at FROM session_revocations WHERE rater_id = ?", args: [raterId] })).rows[0];
  const value = row ? Number(row.revoked_at) : null;
  memo.set(raterId, { read: now, revokedAt: value });
  if (memo.size > 5000) memo.delete(memo.keys().next().value);
  return value;
}

/** Signs out every session of `raterId` signed in at or before `now`. */
export async function revokeSessions(db, raterId, { now = Date.now() } = {}) {
  await db.execute({
    sql: `INSERT INTO session_revocations (rater_id, revoked_at) VALUES (?, ?)
          ON CONFLICT(rater_id) DO UPDATE SET revoked_at = MAX(revoked_at, excluded.revoked_at)`,
    args: [raterId, now],
  });
  memo.set(raterId, { read: now, revokedAt: Math.max(now, memo.get(raterId)?.revokedAt ?? 0) });
}

/** The account id of the admin (ADMIN_GITHUB_ID), or null when there is none. */
export function adminRaterId(env = globalThis.process?.env) {
  const id = String(env?.ADMIN_GITHUB_ID ?? "").trim();
  return /^\d{1,12}$/.test(id) ? `gh:${id}` : null;
}
