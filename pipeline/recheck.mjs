// The hourly re-check of the not-working pool (./not-working.mjs;
// .github/workflows/recheck.yml): only the listed sites whose re-check is due
// (an hour after a first failure, the next day, then the pool's cadence),
// with the same full check the nightly run makes (./health.mjs checkSite,
// with the browser's second opinion) and the same guards: a browser that
// never starts records nothing. A run of a few sites is too small for the
// nightly run's share guards, so it also loads CONTROL_SITES sites that were
// live at their last check; when too few of them load, the runner is the
// likelier culprit and nothing is recorded (CONTROL_PASS_SHARE).
//
// Free: no Gemini. Nobody is emailed: the counts go to the job summary and
// the owner's admin page (/admin/alerts lists the pool).

import { ensureHealthTables, healthSummary, runHealthCheck } from "./health.mjs";
import { DUE_SQL, columnsOf, dueCutoff } from "./not-working.mjs";

/** Live sites loaded beside the due ones as a test of the runner, never recorded. */
export const CONTROL_SITES = 5;

/** The listed sites whose re-check is due at `now`: [{ url, name }]. A database the pool's columns are not in yet (a dry run before the release) has none. */
export async function dueForRecheck(db, now = new Date()) {
  if (!(await columnsOf(db, "health_marks")).has("pool_health")) return [];
  const rows = (await db.execute({ sql: DUE_SQL, args: [dueCutoff(now)] })).rows;
  return rows.map((r) => ({ url: String(r.url), name: r.name == null ? "" : String(r.name) }));
}

/** `n` listed sites that passed their last check and their capture, at random, none of `except`. */
export async function controlSites(db, n = CONTROL_SITES, except = []) {
  if (n <= 0) return [];
  const skip = new Set(except);
  const rows = (
    await db.execute({
      sql: `SELECT url, name FROM portfolios WHERE delisted_at IS NULL AND health = 'live' AND status = 'live' ORDER BY random() LIMIT ?`,
      args: [n + skip.size],
    })
  ).rows;
  return rows
    .map((r) => ({ url: String(r.url), name: r.name == null ? "" : String(r.name) }))
    .filter((r) => !skip.has(r.url))
    .slice(0, n);
}

/** At most this many due sites a run, oldest due first; the rest stay due for the next hour. */
export const RECHECK_LIMIT = 120;
/** No new batch starts after this long (the job's timeout is 30 minutes); the rest stay due. */
export const RECHECK_BUDGET_MS = 20 * 60000;

/** Adds one batch's summary to the run's: counts added, lists joined, the rest the latest. */
function merge(total, s) {
  if (!total) return { ...s };
  const out = { ...total, ...s };
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "number" && typeof total[k] === "number" && k !== "ladderUnknown") out[k] = total[k] + v;
    else if (Array.isArray(v) && Array.isArray(total[k]) && k !== "ladderUnknown") out[k] = [...total[k], ...v];
  }
  // The brake on hiding: its count is the latest batch's (read from the marks), the sites it held add up.
  if (s.hideBrake && total.hideBrake) out.hideBrake = { count: s.hideBrake.count, held: [...total.hideBrake.held, ...s.hideBrake.held] };
  return out;
}

/**
 * Re-check the due sites: at most `limit`, oldest due first, `batch` at a
 * time, each batch written as soon as its checks are done, so finished
 * checks are never lost to a timeout; no batch starts once `budgetMs` has
 * passed (by `clock`, the real clock unless a test gives one). The control
 * sites go with the first batch: if they do not load, nothing is recorded.
 * Each site is stamped when its own check finished (the real clock; a test
 * that passes `now` pins it). Returns { due, left, ...the batches' summary }
 * or { due: 0 } when nothing was due. `dryRun` writes nothing.
 */
export async function runRecheck({
  db,
  fetchImpl = globalThis.fetch,
  render,
  now: nowIn,
  clock,
  log = console.log,
  controls = CONTROL_SITES,
  concurrency = 4,
  batch = 8,
  limit = RECHECK_LIMIT,
  budgetMs = RECHECK_BUDGET_MS,
  dryRun = false,
}) {
  const now = nowIn ?? new Date();
  const time = clock ?? Date.now;
  // The schema once, here; each batch below is told it is ready.
  if (!dryRun) await ensureHealthTables(db);
  const allDue = await dueForRecheck(db, now);
  if (!allDue.length) return { aborted: false, due: 0, checked: 0, dryRun };
  const due = allDue.slice(0, limit);
  const control = await controlSites(db, controls, due.map((d) => d.url));
  const started = time();
  let total = null;
  let done = 0;
  for (let i = 0; i < due.length; i += batch) {
    if (i > 0 && time() - started >= budgetMs) break;
    const s = await runHealthCheck({
      db,
      feed: due.slice(i, i + batch),
      fetchImpl,
      render,
      // Only a test pins the time; the real job stamps each site with the real clock.
      ...(nowIn ? { now: nowIn } : {}),
      ...(clock ? { clock } : {}),
      log,
      concurrency,
      scheduled: "check",
      // The runner's test, before anything is recorded: all the control sites with the first batch, two with
      // each later one (a network that breaks mid-run stops the run there).
      controls: i === 0 ? control : control.slice(0, 2),
      // The review queue's door and the unknown-sites alert from one run's results are the nightly run's.
      doorLimit: 0,
      alerts: false,
      dryRun,
      schemaReady: true,
    });
    if (s.aborted) return { ...merge(total, s), due: allDue.length, left: allDue.length - done, aborted: true, message: s.message };
    total = merge(total, s);
    done += s.checked;
  }
  return { ...total, due: allDue.length, left: allDue.length - done };
}

/** Markdown for GITHUB_STEP_SUMMARY. */
export function recheckSummary(s) {
  if (!s.due) return `## Not-working pool re-check${s.dryRun ? " (dry run: nothing written)" : ""}\n\nNothing due this hour.\n`;
  if (s.aborted) return `## Not-working pool re-check\n\nFAILED: ${s.message}.\n`;
  const body = healthSummary(s).replace(/^## Health check[^\n]*\n\n/, "");
  const left = s.left ? `${s.left} due site(s) were left for the next hour (the run's cap or time budget).\n\n` : "";
  return `## Not-working pool re-check${s.dryRun ? " (dry run: nothing written)" : ""}\n\n${s.controls ?? 0} control site(s), live at their last check, were loaded too as a test of the runner (not recorded).\n\n${left}${body}`;
}
