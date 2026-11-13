// The dead-man check for the end-of-day run (fresh-eyes audit H2), on the
// hourly Cron Trigger ("15 * * * *", worker/night-watch.ts).
//
// The night's own alerts are built at the end of a finished run
// (worker/night.ts), so a night that never started, or one that died
// partway, says nothing by itself. This check looks at the latest night that
// should have started and raises an owner alert (pipeline/alerts.mjs, one
// email a day while it holds) when:
//
//   night-watch:missed   it has no night_runs row an hour after its start
//                        (the cron didn't fire, the Workflow couldn't be
//                        created, or GEMINI_API_KEY is missing)
//   night-watch:stuck    its row still says "running" an hour after the
//                        hard stop, and its Workflow instance is not paused
//                        (a run the owner paused on purpose is left alone)
//
// Both clear on their own once a later night starts and finishes.
import { pacificParts, quotaDay } from "./quota-day.mjs";
import { nightTimeline } from "./budget.mjs";

export const NIGHT_WATCH_PREFIX = "night-watch:";
export const isNightWatchAlert = (key) => String(key).startsWith(NIGHT_WATCH_PREFIX);

/** How long after the start (and after the hard stop) the check waits before it calls a night missed (or stuck). */
export const GRACE_MINUTES = 60;

/**
 * The latest night whose start (plan.startHour:startMinute Pacific) plus the
 * grace has passed at `now`: today's Pacific date from then on, else yesterday's.
 */
export function expectedNight(now, plan, graceMinutes = GRACE_MINUTES) {
  const at = new Date(now);
  const p = pacificParts(at);
  const minutes = p.hour * 60 + p.minute;
  const due = plan.startHour * 60 + plan.startMinute + graceMinutes;
  if (minutes >= due) return quotaDay(at).day;
  // Yesterday's quota day: one minute before today's started.
  return quotaDay(new Date(quotaDay(at).start.getTime() - 60000)).day;
}

/**
 * Is this error from creating a Workflow instance the "an instance with this
 * id already exists" one (tonight already ran or is running)? Anything else
 * (an outage, a bad binding) is a real failure.
 */
export function isDuplicateInstance(e) {
  return /already[ _.-]?exists/i.test(String(e?.message ?? e));
}

/**
 * The dead-man conditions that hold at `now`. `instanceStatus(runId)` returns
 * the Workflow instance's status ("running", "paused", "errored", ...) or
 * null when it can't tell.
 * @param {{ execute: Function }} db
 * @param {{ now: Date, plan: any, instanceStatus?: (id: string) => Promise<string | null> }} options
 */
export async function nightWatchConditions(db, { now, plan, instanceStatus = async () => null }) {
  const night = expectedNight(now, plan);
  let row;
  try {
    row = (await db.execute({ sql: "SELECT night, started_at, status, run_id FROM night_runs WHERE night = ?", args: [night] })).rows[0];
  } catch (e) {
    // No night_runs table: no night has ever run in this database.
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
    row = undefined;
  }
  if (!row) {
    return [
      {
        key: `${NIGHT_WATCH_PREFIX}missed`,
        kind: "problem",
        title: "The end-of-day run didn't start",
        detail:
          `The run for ${night} (20:30 Pacific) has not started. ` +
          "Check the Worker's logs and Sentry for night.cron.failed, that the portfolio-rank Worker's crons are set, and that GEMINI_API_KEY is set (without it the run skips itself).",
      },
    ];
  }
  if (String(row.status) !== "running") return [];
  const overdue = new Date(nightTimeline(String(row.started_at), plan).hardStop).getTime() + GRACE_MINUTES * 60000;
  if (new Date(now).getTime() < overdue) return [];
  const runId = row.run_id == null ? null : String(row.run_id);
  let status = null;
  try {
    status = runId ? await instanceStatus(runId) : null;
  } catch {
    status = null;
  }
  if (status === "paused" || status === "waitingForPause") return [];
  return [
    {
      key: `${NIGHT_WATCH_PREFIX}stuck`,
      kind: "problem",
      title: "The end-of-day run died or is stuck",
      detail:
        `The run for ${night} started at ${row.started_at} and still says "running" after its hard stop` +
        `${runId ? ` (Workflow instance ${runId}: ${status ?? "status unknown"})` : ""}. ` +
        "Its summary and alerts were never written. Check the instance in the Cloudflare dashboard (Workflows, portfolio-rank-night) and the Worker's logs.",
    },
  ];
}
