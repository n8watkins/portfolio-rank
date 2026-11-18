// Starts the hourly re-check of sites that stopped working
// (.github/workflows/recheck.yml, pipeline/recheck-run.mjs) from the hourly
// Cron Trigger ("15 * * * *", worker/index.ts). GitHub's own schedule is
// best-effort and ran the re-check 3 times in its first 27 hours instead of
// 27; Cloudflare's cron is on time, so the Worker starts it, the same way
// the night starts the health check (worker/night.ts), and the GitHub
// schedule stays as the fallback (its guard skips when this started a run).
//
// The database client comes in as `deps.db` (index.ts passes lib/db's), which
// keeps this file free of the Worker-only module so a unit test can import it.
//
// Cheap when there is nothing to do: one indexed count (the workflow's own
// first question, DUE_COUNT_SQL) and, only when a site is due, one fetch.
import { dispatchWorkflow } from "../pipeline/github-dispatch.mjs";
import { dispatchTokenConditions, emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { DUE_COUNT_SQL, dueCutoff } from "../pipeline/not-working.mjs";
import type { Client } from "@libsql/client";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

/** What the tick needs from outside, so a test can stand in for each. */
export type RecheckStartDeps = {
  db: Pick<Client, "execute" | "transaction">;
  dispatch?: typeof dispatchWorkflow;
  alert?: (conditions: ReturnType<typeof dispatchTokenConditions>, now: Date) => Promise<unknown>;
};

/**
 * Starts recheck.yml when at least one site is due. Throws when the count
 * cannot be read or GitHub refuses the dispatch (the hourly runEach reports
 * it to Sentry; the next hour tries again, and the workflow's GitHub schedule
 * is the fallback meanwhile). A missing or expiring token raises the same
 * owner alert the night does (dispatch-token:missing / dispatch-token:expiring,
 * which the night clears).
 */
export async function recheckStartTick(env: NightEnv, scheduledTime: number, deps: RecheckStartDeps) {
  const now = new Date(scheduledTime);
  const { db } = deps;
  const res = await db.execute({ sql: DUE_COUNT_SQL, args: [dueCutoff(now)] });
  const due = Number(res.rows[0]?.n ?? 0);
  if (due === 0) return { due, started: false as const };

  const dispatch = deps.dispatch ?? dispatchWorkflow;
  const result = await dispatch({ token: env.GITHUB_DISPATCH_TOKEN, workflow: "recheck.yml", log: (line: string) => log("recheck.start", { line }) });
  const conditions = dispatchTokenConditions(result as { skipped?: string; tokenExpires?: string | null }, { now });
  if (conditions.length) {
    const alert =
      deps.alert ??
      ((c: typeof conditions, at: Date) =>
        // Raise only: the night owns clearing (its own dispatch sees the same token).
        reconcileAlerts(db, { conditions: c, scope: () => false, now: at, email: emailSender(env, { db }), to: env.OWNER_EMAIL ?? null, log: (line: string) => log("recheck.alert", { line }) }));
    await alert(conditions, now);
  }
  if ("skipped" in result) return { due, started: false as const, skipped: String(result.skipped) };
  log("recheck.started", { due, runId: result.runId, url: result.url });
  return { due, started: true as const, runId: result.runId };
}
