// The image library's hourly batch (docs/CONTENT-ENGINE.md, "The image
// library"), run by the hourly Cron Trigger ("15 * * * *", worker/index.ts)
// after people's queued grades: up to LIBRARY_PER_HOUR (40) images, never
// between 20:00 and midnight Pacific, every Workers AI call through the
// portfoliorank-ai AI Gateway (lib/ai-gateway.mjs) and the never-pay limits
// (lib/content/neurons.mjs: 40 a UTC day, 2,500 neurons).
// A failure or the gateway's 429 stops the batch; the next tick tries again.
import { db as database } from "../lib/db";
import { withGateway } from "../lib/ai-gateway.mjs";
import { runLibraryBatch } from "../pipeline/content/library-stage.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function libraryTick(env: NightEnv, scheduledTime: number) {
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
      runId: `library-tick-${new Date(scheduledTime).toISOString()}`,
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
