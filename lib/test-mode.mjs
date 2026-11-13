// Whether test stand-ins may be used: the GRADER_TEST_*, GAMES_TEST_* and
// BLOG_TEST_* seams (lib/grader/server.ts testSeam) and the email outbox
// (lib/email/gate.mjs). An allow-list: only the test runs (SITE_ENV "test",
// scripts/test-e2e.sh) and `next dev` say yes. Anything else, including a
// Worker whose SITE_ENV is missing or misspelled, says no, so a stray
// variable can never reroute real traffic or swallow real emails.

/**
 * @param {{ SITE_ENV?: string, NODE_ENV?: string } | undefined} env
 * @param {{ dev?: boolean }} [options] dev: whether `next dev` (NODE_ENV "development") counts too
 */
export function testStandInsAllowed(env, { dev = true } = {}) {
  if (env?.SITE_ENV === "test") return true;
  return dev && env?.NODE_ENV === "development";
}
