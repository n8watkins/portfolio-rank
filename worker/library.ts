// The image library's daily automatic run (docs/CONTENT-ENGINE.md, "The
// image library"), on the hourly Cron Trigger ("15 * * * *", worker/index.ts)
// after people's queued grades, but only in the UTC hour LIBRARY_RUN_HOUR_UTC
// (23, so 23:15 UTC, near the end of the image day): whatever is left of the
// day's 40 images and 2,500 neurons, every Workers AI call through the
// portfoliorank-ai AI Gateway (lib/ai-gateway.mjs) and reserved first
// (lib/content/neurons.mjs), and no image started within 5 minutes of 00:00
// UTC. A failure, a refused reservation or the gateway's 429 stops the run;
// tomorrow's run tries again. Every other hour does nothing.
import { db as database } from "../lib/db";
import { withGateway } from "../lib/ai-gateway.mjs";
import { libraryRunDue, runLibraryBatch } from "../pipeline/content/library-stage.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function libraryTick(env: NightEnv, scheduledTime: number) {
  if (!libraryRunDue(scheduledTime, env as unknown as Record<string, unknown>)) return { made: [], skipped: "not the daily run's hour" };
  const ai = withGateway(env.AI);
  if (!ai) return { made: [], error: "off", stopped: "no Workers AI binding" };
  try {
    const r = await runLibraryBatch({
      db: database(),
      env: env as unknown as Record<string, unknown>,
      ai,
      store: async (key: string, bytes: Uint8Array, contentType: string) => {
        await env.SHOTS.put(key, bytes, { httpMetadata: { contentType } });
        return key;
      },
      apiKey: env.GEMINI_API_KEY,
      runId: `library-daily-${new Date(scheduledTime).toISOString()}`,
      now: () => Date.now(),
      log: (line: string) => log("library.log", { line }),
    });
    if (r.made.length || (r.stopped && r.error !== "off")) log("library.tick", r);
    return r;
  } catch (e) {
    // Housekeeping: never fails the cron's other work.
    log("library.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { made: [], error: "failed" };
  }
}
