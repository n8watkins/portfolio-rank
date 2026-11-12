// Roll-ups and retention for the log tables (docs/COSTS.md section C, fixes
// 6 and 9), run once a night after the end-of-day run (worker/night.ts) and
// safe to run again at any time:
//
//   gemini_requests  raw rows are kept GEMINI_RAW_DAYS (90) Pacific quota
//                    days; older days become one row per day, model, job
//                    and outcome in gemini_daily (requests, tokens, latency
//                    percentiles), written and deleted in one transaction
//                    per day so nothing is counted twice or lost. Budgets
//                    read only today's raw rows and the admin view only the
//                    last 30 days, so neither notices.
//   night_runs       the summary of each end-of-day run is kept
//                    NIGHT_RUN_DAYS (180) days; its Gemini use lives on in
//                    gemini_daily.
//   comparisons      every row stays: the open method and the recompute
//                    need who compared what, how, in which order and with
//                    which result. Only the free-text `reason` (the model's
//                    one-sentence explanation, which no recompute reads) is
//                    cleared after COMPARISON_REASON_DAYS (90) days.
//   owner_alerts     cleared alerts are deleted after 180 days.
//   grade_links      one-time links (lib/grader/links.mjs) are deleted once
//                    they expire, whichever feature is on (the grader's
//                    tick does the same hourly while it runs).
//   badge_checks     a player's last badge check (a 15-second reuse) is
//                    deleted after a day; the next check rebuilds it.
//   email_signin_tokens  sign-in links (lib/signin/store.mjs), with the
//                    address they were for, a day after they expire or once
//                    used (each new request also clears them).
import { pruneTokens } from "../lib/signin/store.mjs";
import { quotaDay } from "./quota-day.mjs";
import { pruneLinks } from "../lib/grader/links.mjs";

export const GEMINI_RAW_DAYS = 90;
export const NIGHT_RUN_DAYS = 180;
export const COMPARISON_REASON_DAYS = 90;
export const CLEARED_ALERT_DAYS = 180;

const DAY_MS = 86400000;

export async function ensureGeminiDaily(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS gemini_daily (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    job TEXT NOT NULL,
    outcome TEXT NOT NULL,
    requests INTEGER NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thoughts_tokens INTEGER NOT NULL DEFAULT 0,
    latency_p50 INTEGER,
    latency_p95 INTEGER,
    PRIMARY KEY (day, model, job, outcome)
  )`);
}

/** What a logged request came to: ok, cut_off, 429, 5xx, network or 4xx. */
export function outcomeOf(r) {
  const status = Number(r.status ?? 0);
  if (status === 200) return r.finish_reason && r.finish_reason !== "STOP" ? "cut_off" : "ok";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (!status) return "network";
  return "4xx";
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

async function tableExists(db, name) {
  return (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] })).rows.length > 0;
}

/**
 * Rolls every whole Pacific quota day older than `keepDays` from
 * gemini_requests into gemini_daily and deletes those raw rows. Returns
 * { days, rows } rolled up.
 */
export async function rollUpGeminiRequests(db, { now = new Date(), keepDays = GEMINI_RAW_DAYS } = {}) {
  if (!(await tableExists(db, "gemini_requests"))) return { days: 0, rows: 0 };
  await ensureGeminiDaily(db);
  // The first quota day that stays raw starts at this instant.
  const keepFrom = quotaDay(new Date(now.getTime() - keepDays * DAY_MS)).start;
  let days = 0;
  let rows = 0;
  for (;;) {
    const oldest = (await db.execute({ sql: "SELECT MIN(at) AS at FROM gemini_requests WHERE at < ?", args: [keepFrom.toISOString()] })).rows[0]?.at;
    if (oldest == null) break;
    const { day, start, end } = quotaDay(new Date(String(oldest)));
    const range = [start.toISOString(), end.toISOString()];
    const res = await db.execute({
      sql: `SELECT model, job, status, finish_reason, retry, input_tokens, output_tokens, thoughts_tokens, latency_ms
            FROM gemini_requests WHERE at >= ? AND at < ?`,
      args: range,
    });
    const groups = new Map();
    for (const r of res.rows) {
      const g = { model: String(r.model), job: String(r.job ?? "unknown"), outcome: outcomeOf(r) };
      const key = `${g.model}\n${g.job}\n${g.outcome}`;
      const acc = groups.get(key) ?? { ...g, requests: 0, retries: 0, input: 0, output: 0, thoughts: 0, latencies: [] };
      acc.requests++;
      acc.retries += Number(r.retry ?? 0) ? 1 : 0;
      acc.input += Number(r.input_tokens ?? 0);
      acc.output += Number(r.output_tokens ?? 0);
      acc.thoughts += Number(r.thoughts_tokens ?? 0);
      if (r.latency_ms != null) acc.latencies.push(Number(r.latency_ms));
      groups.set(key, acc);
    }
    const stmts = [...groups.values()].map((g) => {
      const lat = g.latencies.sort((a, b) => a - b);
      return {
        sql: `INSERT INTO gemini_daily (day, model, job, outcome, requests, retries, input_tokens, output_tokens, thoughts_tokens, latency_p50, latency_p95)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(day, model, job, outcome) DO UPDATE SET
                requests = requests + excluded.requests, retries = retries + excluded.retries,
                input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
                thoughts_tokens = thoughts_tokens + excluded.thoughts_tokens,
                latency_p50 = COALESCE(excluded.latency_p50, latency_p50), latency_p95 = COALESCE(excluded.latency_p95, latency_p95)`,
        args: [day, g.model, g.job, g.outcome, g.requests, g.retries, g.input, g.output, g.thoughts, percentile(lat, 0.5), percentile(lat, 0.95)],
      };
    });
    // The roll-up and the delete commit together, or neither does.
    stmts.push({ sql: "DELETE FROM gemini_requests WHERE at >= ? AND at < ?", args: range });
    await db.batch(stmts, "write");
    days++;
    rows += res.rows.length;
  }
  return { days, rows };
}

/** Deletes and clears what the retention rules above say. Returns the counts. */
export async function pruneLogs(db, { now = new Date() } = {}) {
  const before = (days) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const out = { nightRuns: 0, reasons: 0, alerts: 0, links: 0, badgeChecks: 0 };
  if (await tableExists(db, "night_runs")) {
    // night is a Pacific date ("YYYY-MM-DD"): compare dates.
    out.nightRuns = (await db.execute({ sql: "DELETE FROM night_runs WHERE night < ?", args: [before(NIGHT_RUN_DAYS).slice(0, 10)] })).rowsAffected;
  }
  if (await tableExists(db, "comparisons")) {
    out.reasons = (
      // Only the band that crossed the line in the last 30 days (missed nights
      // included), through the created_at index, so a night never rescans
      // the whole history.
      await db.execute({
        sql: "UPDATE comparisons SET reason = NULL WHERE created_at >= ? AND created_at < ? AND reason IS NOT NULL",
        args: [before(COMPARISON_REASON_DAYS + 30), before(COMPARISON_REASON_DAYS)],
      })
    ).rowsAffected;
  }
  if (await tableExists(db, "owner_alerts")) {
    out.alerts = (await db.execute({ sql: "DELETE FROM owner_alerts WHERE cleared_at IS NOT NULL AND cleared_at < ?", args: [before(CLEARED_ALERT_DAYS)] })).rowsAffected;
  }
  if (await tableExists(db, "grade_links")) {
    out.links = await pruneLinks(db, { now: now.getTime() });
  }
  if (await tableExists(db, "email_signin_tokens")) {
    out.signinTokens = await pruneTokens(db, { now: now.getTime() });
  }
  if (await tableExists(db, "badge_checks")) {
    out.badgeChecks = (await db.execute({ sql: "DELETE FROM badge_checks WHERE at < ?", args: [now.getTime() - DAY_MS] })).rowsAffected;
  }
  return out;
}

/** The nightly retention pass: roll-ups first, then pruning. */
export async function retention(db, { now = new Date() } = {}) {
  const rolled = await rollUpGeminiRequests(db, { now });
  const pruned = await pruneLogs(db, { now });
  return { rolled, pruned };
}
