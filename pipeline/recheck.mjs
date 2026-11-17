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

import { healthSummary, runHealthCheck } from "./health.mjs";
import { DUE_SQL, dueCutoff, ensureHealthSchema } from "./not-working.mjs";

/** Live sites loaded beside the due ones as a test of the runner, never recorded. */
export const CONTROL_SITES = 5;

/** The listed sites whose re-check is due at `now`: [{ url, name }]. */
export async function dueForRecheck(db, now = new Date()) {
  await ensureHealthSchema(db);
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

/**
 * Re-check the due sites. Returns { due, ...runHealthCheck's summary } or
 * { due: 0 } when nothing was due (no site loaded at all).
 */
export async function runRecheck({ db, fetchImpl = globalThis.fetch, render, now = new Date(), log = console.log, controls = CONTROL_SITES, concurrency = 4 }) {
  const due = await dueForRecheck(db, now);
  if (!due.length) return { aborted: false, due: 0, checked: 0 };
  const control = await controlSites(db, controls, due.map((d) => d.url));
  const s = await runHealthCheck({
    db,
    feed: due,
    fetchImpl,
    render,
    now,
    log,
    concurrency,
    scheduled: "check",
    controls: control,
    // The review queue's door and the owner's unknown-sites alert are the nightly run's.
    doorLimit: 0,
    alerts: false,
  });
  return { due: due.length, ...s };
}

/** Markdown for GITHUB_STEP_SUMMARY. */
export function recheckSummary(s) {
  if (!s.due) return "## Not-working pool re-check\n\nNothing due this hour.\n";
  if (s.aborted) return `## Not-working pool re-check\n\nFAILED: ${s.message}.\n`;
  const body = healthSummary(s).replace(/^## Health check\n\n/, "");
  return `## Not-working pool re-check\n\n${s.controls ?? 0} control site(s), live at their last check, were loaded too as a test of the runner (not recorded).\n\n${body}`;
}
