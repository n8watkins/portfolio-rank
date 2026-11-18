// Starts the hourly re-check of sites that stopped working
// (.github/workflows/recheck.yml, pipeline/recheck-run.mjs) from the hourly
// Cron Trigger ("15 * * * *", worker/index.ts). GitHub's own schedule is
// best-effort and ran the re-check 3 times in its first 27 hours instead of
// 27; Cloudflare's cron is on time, so the Worker starts it, the same way
// the night starts the health check (worker/night.ts), and the GitHub
// schedule stays as the fallback (its guard skips when this started a run).
//
// It is the first hourly task (worker/index.ts): it is the one with a time
// to keep, and a slow task ahead of it must not delay or drop it.
//
// The database client comes in as `deps.db` (index.ts passes lib/db's), which
// keeps this file free of the Worker-only module so a unit test can import it.
//
// Cheap when there is nothing to do: one indexed count (the workflow's own
// first question, DUE_COUNT_SQL) and, only when a site is due, one fetch.
import { dispatchWorkflow } from "../pipeline/github-dispatch.mjs";
import { DUE_COUNT_SQL, dueCutoff } from "../pipeline/not-working.mjs";
import type { Client } from "@libsql/client";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

/** What the tick needs from outside, so a test can stand in for each. */
export type RecheckStartDeps = {
  db: Pick<Client, "execute">;
  dispatch?: typeof dispatchWorkflow;
};

/**
 * Starts recheck.yml when at least one site is due, or when the count cannot
 * be read (the workflow counts again and, like pipeline/recheck-due.mjs,
 * treats "unknown" as work to do); the count's error is then thrown after the
 * dispatch so it is still reported. A dispatch GitHub refuses is tried once
 * more, then thrown (the hourly runEach reports it to Sentry; the next hour
 * tries again, and the workflow's GitHub schedule is the fallback meanwhile).
 * Without GITHUB_DISPATCH_TOKEN nothing starts and the fallback does the
 * work; the night raises the owner's alert about the token (worker/night.ts).
 */
export async function recheckStartTick(env: NightEnv, scheduledTime: number, deps: RecheckStartDeps) {
  const now = new Date(scheduledTime);
  let due: number | null = null;
  let countError: unknown = null;
  try {
    const res = await deps.db.execute({ sql: DUE_COUNT_SQL, args: [dueCutoff(now)] });
    due = Number(res.rows[0]?.n ?? 0);
  } catch (e) {
    countError = e;
  }
  if (due === 0) return { due, started: false as const };

  const dispatch = deps.dispatch ?? dispatchWorkflow;
  const start = () => dispatch({ token: env.GITHUB_DISPATCH_TOKEN, workflow: "recheck.yml", log: (line: string) => log("recheck.start", { line }) });
  const result = await start().catch((e: unknown) => {
    log("recheck.start_retry", { error: e instanceof Error ? e.message : String(e) });
    return start();
  });
  if (countError) {
    log("recheck.count_failed", { started: !("skipped" in result) });
    throw countError;
  }
  if ("skipped" in result) return { due, started: false as const, skipped: String(result.skipped) };
  log("recheck.started", { due, runId: result.runId, url: result.url });
  return { due, started: true as const, runId: result.runId };
}
