import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * The Worker's bindings and context, for code that reaches them from the app.
 * Test runs (scripts/test-e2e.sh sets SITE_ENV=test) get none: under
 * `next start` the context is a local simulation of wrangler.jsonc that also
 * opens a remote connection (Workers AI is always remote) and leaves a
 * workerd process behind, and the tests stand in for every binding anyway.
 * Throws where there is no context, like getCloudflareContext itself.
 */
export async function cloudflareContext() {
  if (process.env.SITE_ENV === "test") throw new Error("no Cloudflare context in test runs");
  return getCloudflareContext({ async: true });
}
