// Starts the daily Lighthouse job (.github/workflows/prewarm.yml,
// scripts/prewarm-metrics.mjs) from the hourly Cron Trigger ("15 * * * *",
// worker/index.ts), the way worker/recheck-start.ts starts the re-check.
// GitHub's own schedule is best-effort and started this job 7 to 12 hours
// late (15:59 to 20:46 UTC over Nov 15 to 27 instead of 09:00); Cloudflare's
// cron is on time. The GitHub schedule stays as the fallback: its guard skips
// when a dispatched run already started that UTC day, so the 1,600 PageSpeed
// calls of a full run are never spent twice.
//
// No new Cron Trigger (Cloudflare limits their count): it runs in the 09 UTC
// hour of the existing hourly tick, so at about 09:15, and at most once a
// day. A dispatch GitHub refuses is tried once more in the same tick, then
// thrown (the hourly runEach reports it to Sentry); the next tick is outside
// the 09 hour, so it is not tried again and the GitHub schedule is the
// fallback. Without GITHUB_DISPATCH_TOKEN nothing starts (the night raises the
// owner's alert about the token, worker/night.ts).
//
// It sends no inputs: the workflow's own defaults then apply (code empty is
// production's release, limit 400).
import { dispatchWorkflow } from "../pipeline/github-dispatch.mjs";
import type { NightEnv } from "./night";

/** The UTC hour the job starts in (the hourly tick is at :15, so 09:15). */
export const PREWARM_HOUR_UTC = 9;

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

/** What the tick needs from outside, so a test can stand in for it. */
export type PrewarmStartDeps = { dispatch?: typeof dispatchWorkflow };

export async function prewarmStartTick(env: NightEnv, scheduledTime: number, deps: PrewarmStartDeps = {}) {
  if (new Date(scheduledTime).getUTCHours() !== PREWARM_HOUR_UTC) return { started: false as const };

  const dispatch = deps.dispatch ?? dispatchWorkflow;
  const start = () => dispatch({ token: env.GITHUB_DISPATCH_TOKEN, workflow: "prewarm.yml", log: (line: string) => log("prewarm.start", { line }) });
  const result = await start().catch((e: unknown) => {
    log("prewarm.start_retry", { error: e instanceof Error ? e.message : String(e) });
    return start();
  });
  if ("skipped" in result) return { started: false as const, skipped: String(result.skipped) };
  log("prewarm.started", { runId: result.runId, url: result.url });
  return { started: true as const, runId: result.runId };
}
