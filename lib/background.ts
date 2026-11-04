import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Keep `work` running after the response is sent. On Workers this hands it to
 * `ctx.waitUntil`, without which the isolate may stop once the response is
 * out; under `next start` (tests, local) the Node process keeps it alive.
 * Errors are swallowed: background work must never fail a request.
 */
export function runInBackground(work: Promise<unknown>): void {
  const quiet = work.catch(() => {});
  try {
    getCloudflareContext().ctx.waitUntil(quiet);
  } catch {
    /* not on Workers: the promise runs on its own */
  }
}
