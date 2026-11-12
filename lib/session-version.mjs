// Session version: a claim stamped into every session token at sign-in. A
// session whose claim is not the current version is treated as signed out
// (auth.ts), so bumping this number signs everyone out once. It touches
// nothing else: AUTH_SECRET also signs one-time links, ownership cookies and
// the badge and claim tokens, so rotating it would break those too.
//
// 2 (2026-11-11): sessions made before the account creation date was kept
// (MIN_GITHUB_ACCOUNT_AGE_DAYS) are signed out once so they pick it up.
export const SESSION_VERSION = 2;

/** True when the token carries the current session version. */
export const isCurrentSession = (token) => token?.sv === SESSION_VERSION;
