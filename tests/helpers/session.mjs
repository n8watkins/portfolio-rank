// Signed-in sessions for the end-to-end tests: an Auth.js session cookie the
// app under test (scripts/test-e2e.sh, same AUTH_SECRET) reads like a real
// GitHub sign-in. Accounts are a year old unless a test asks for a newer one,
// so MIN_GITHUB_ACCOUNT_AGE_DAYS (30 in the test run, as in wrangler.jsonc)
// only matters where a test means it to.
import { encode } from "@auth/core/jwt";

/** The admin's numeric GitHub id in the test run (scripts/test-e2e.sh ADMIN_GITHUB_ID). */
export const ADMIN_ID = 990000000;

const DAY = 24 * 60 * 60 * 1000;

/**
 * The session token for GitHub account `id` (raterId gh:<id>) with `login`,
 * created `ageDays` ago (null: a session from before the account date was
 * recorded).
 */
export async function sessionToken({ id, login = `e2e-${id}`, ageDays = 365 } = {}) {
  const token = { raterId: `gh:${id}`, login, sub: String(id) };
  if (ageDays != null) token.accountCreatedAt = new Date(Date.now() - ageDays * DAY).toISOString();
  return encode({ token, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 });
}

/** `authjs.session-token=<token>`, for a request's cookie header. */
export async function sessionCookie(opts) {
  return `authjs.session-token=${await sessionToken(opts)}`;
}
