// The not-working pool (owner, 2026-11-16): a listed site that stops
// answering (paused hosting, a deleted deployment, a dead domain, a refused
// connection) leaves the AI's work at once, and the site itself a day later
// if it is still not answering. Nothing is deleted on the way: the row, the
// grade, the votes, the ratings and the screenshots stay, so a site that
// answers again comes back exactly as it was. Nobody is emailed about it.
//
//   live --first failed check--> failing (health 'suspect', stage 1):
//        out of grading, AI comparisons, polls and blog facts
//        (pipeline/roster.mjs ACTIVE); still shown to visitors
//   stage 1 --re-check about RECHECK_AFTER_MS later fails--> stage 2
//   stage 2 --re-check CONFIRM_AFTER_MS after the first failure fails-->
//        not working (health 'down', stage 3, pool_since): hidden from
//        visitors everywhere (lib/hidden.mjs HIDDEN_WHERE), its profile
//        answers not found (lib/hidden.mjs GONE_WHERE)
//   not working: re-checked on POOL_CADENCE; after LEAVE_AFTER_DAYS it leaves
//        the list (pipeline/exclusions.mjs planExclusions, data/excluded.json
//        through the weekly pull request), where the monthly re-check of
//        removed "down" entries can still bring it back
//   any stage --a full check passes--> live, the ladder cleared
//   a check that could not tell (a timeout, a dropped connection, a bot
//        wall): nothing changes, and the re-check is tried again next hour
//
// A check counts as a stage's re-check only when it comes when that re-check
// is due (pool_next_at, less DUE_SLACK_MS): two failures on one bad day, or
// a weekly run in between, never skip a stage. The re-checks are the same
// full check the weekly run makes (pipeline/health.mjs checkSite, with the
// browser's second opinion), run hourly for the sites that are due
// (pipeline/recheck.mjs, .github/workflows/recheck.yml).
//
// Only a site that does not answer is on this ladder (notAnswering). One that
// answers with something else (a parked page, a blank page, a redirect to a
// social profile, a duplicate, a blocked capture) keeps the weekly ladder of
// pipeline/health.mjs (FAILS_TO_DOWN failed weeks), and a bot wall or a check
// that could not tell is never a failure at all. Once a site is on this
// ladder, any further failure keeps it here until it passes.
//
// The state lives in two places: portfolios.health ('suspect' while failing,
// 'down' when not working, which every reader of the hidden rule already
// understands) and health_marks' pool_* columns (lib/pipeline-schema.mjs).
//
// No imports beyond the schema: pipeline/recheck-due.mjs runs this file's
// count query in the hourly workflow before `npm ci`.

import { HEALTH_AFTER, HEALTH_COLUMNS, HEALTH_TABLES, applyTables } from "../lib/pipeline-schema.mjs";

const HOUR = 3600000;
const DAY = 86400000;

// The owner's numbers (2026-11-16). Change them here; nothing else holds them.
/** The first re-check, about an hour after the first failure. */
export const RECHECK_AFTER_MS = 1 * HOUR;
/** DEFAULT: the confirming re-check, the next day; still failing then, the site is not working. */
export const CONFIRM_AFTER_MS = 1 * DAY;
/** DEFAULT: how often a not-working site is checked again, by days since it became not working: daily for a week, weekly to day 30, then monthly. */
export const POOL_CADENCE = [
  { untilDays: 7, everyDays: 1 },
  { untilDays: 30, everyDays: 7 },
  { untilDays: Infinity, everyDays: 30 },
];
/** DEFAULT: days not working before the site leaves the list (data/excluded.json). */
export const LEAVE_AFTER_DAYS = 90;

/** A re-check counts when it comes this early or later: the hourly job runs on the hour, not to the minute. */
export const DUE_SLACK_MS = 15 * 60000;
/** Stages: failed once, failed the first re-check, not working. */
export const FAILING = 1;
export const RECHECKED = 2;
export const NOT_WORKING = 3;

/**
 * Whether a failed check's reason says the site does not answer: the name
 * does not resolve, nothing answers at the address, TLS fails, an HTTP error
 * (a paused deployment's 402, a deleted deployment's 404, a 5xx). A page that
 * answers with the wrong thing (parked, blank, a redirect, a blocked capture,
 * a duplicate) is not. The same reasons are the ones a removed "down" entry
 * can come back from (pipeline/exclusions.mjs recheckDue).
 */
export const notAnswering = (reason) => /^(HTTP \d|does not load|DNS|connect timeout|TLS|timeout|connection dropped)/.test(String(reason ?? ""));

/** Days between re-checks of a site not working for `ageDays` days (POOL_CADENCE). */
export const cadenceDays = (ageDays) => (POOL_CADENCE.find((c) => ageDays < c.untilDays) ?? POOL_CADENCE[POOL_CADENCE.length - 1]).everyDays;

const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => (s == null ? NaN : Date.parse(String(s)));

/** A site's ladder as stored in health_marks (a row read with the pool_* columns), or null when it is on none. */
export function poolOf(row) {
  const stage = Number(row?.pool_stage ?? 0);
  if (!stage) return null;
  const str = (v) => (v == null ? null : String(v));
  return { stage, startedAt: str(row.pool_started_at), nextAt: str(row.pool_next_at), since: str(row.pool_since) };
}

/**
 * One failed check on the pool's ladder. prev: { health, fails, firstFailAt,
 * lastFailAt, reason, pool } (pool: poolOf, or null). Returns the new
 * { health, fails, firstFailAt, lastFailAt, reason, pool }.
 *
 * A site not yet on the ladder joins it: a live (or new) site at stage 1
 * now. One already failing on the weekly ladder ('suspect', from before this
 * pool existed or for another reason) joins at stage 1 from its first
 * failure, so this check counts as the first re-check when it comes an hour
 * or more after that. One already 'down' for not answering (confirmed by the
 * old three-week rule, its exclusion not yet merged) is not working since
 * its first failure. See AUTOMATION.md "Not working".
 */
export function failOnLadder(prev, result, now = new Date()) {
  const t = now.getTime();
  let pool = prev?.pool ?? null;
  if (!pool) {
    const health = prev?.health ?? null;
    const first = prev?.firstFailAt && Number.isFinite(ms(prev.firstFailAt)) ? String(prev.firstFailAt) : null;
    if (health === "suspect" && first) {
      pool = { stage: FAILING, startedAt: first, nextAt: iso(ms(first) + RECHECK_AFTER_MS), since: null };
    } else if (health === "down") {
      const start = first ?? iso(t);
      pool = { stage: NOT_WORKING, startedAt: start, nextAt: null, since: start };
    } else {
      // The first failure: out of the AI's work now, re-checked in about an hour.
      return {
        health: "suspect",
        fails: 1,
        firstFailAt: iso(t),
        lastFailAt: iso(t),
        reason: result.reason,
        pool: { stage: FAILING, startedAt: iso(t), nextAt: iso(t + RECHECK_AFTER_MS), since: null },
      };
    }
  }
  const due = pool.nextAt == null || t >= ms(pool.nextAt) - DUE_SLACK_MS;
  let next = pool;
  if (due) {
    if (pool.stage === FAILING) {
      // The first re-check failed: the confirming one comes the next day (and never within the hour).
      next = { ...pool, stage: RECHECKED, nextAt: iso(Math.max(ms(pool.startedAt) + CONFIRM_AFTER_MS, t + RECHECK_AFTER_MS)) };
    } else if (pool.stage === RECHECKED) {
      // Still failing the next day: not working.
      next = { ...pool, stage: NOT_WORKING, since: iso(t), nextAt: iso(t + cadenceDays(0) * DAY) };
    } else {
      const since = ms(pool.since ?? pool.startedAt);
      next = { ...pool, stage: NOT_WORKING, nextAt: iso(t + cadenceDays((t - since) / DAY) * DAY) };
    }
  }
  return {
    health: next.stage >= NOT_WORKING ? "down" : "suspect",
    fails: Math.max(Number(prev?.fails ?? 0), next.stage),
    firstFailAt: next.startedAt,
    lastFailAt: due ? iso(t) : prev?.lastFailAt ?? null,
    reason: result.reason,
    pool: next,
  };
}

/** Whether a site not working since `since` has been so for LEAVE_AFTER_DAYS by `now` (it then leaves the list). */
export const leavesList = (since, now = new Date()) => Number.isFinite(ms(since)) && now.getTime() - ms(since) >= LEAVE_AFTER_DAYS * DAY;

/** Creates health_marks with the pool's columns and index (idempotent; lib/schema.mjs runs the same). */
export async function ensureHealthSchema(db) {
  await applyTables(db, HEALTH_TABLES, HEALTH_COLUMNS);
  for (const sql of HEALTH_AFTER) await db.execute(sql);
}

/** SQL condition on health_marks `m` joined to portfolios `p`: the site is on the ladder, so the hourly re-check owns it. */
const ON_LADDER = "m.pool_next_at IS NOT NULL AND p.delisted_at IS NULL AND p.health IN ('suspect', 'down')";

/**
 * SQL: the listed sites on the ladder (url), which the nightly full run
 * leaves to the hourly re-check. A site whose health was set back to live by
 * hand (an Undo, the owner) is not, whatever its marks say.
 */
export const ON_LADDER_SQL = `SELECT p.url FROM health_marks m JOIN portfolios p ON p.url = m.url WHERE ${ON_LADDER}`;

/**
 * SQL (one argument: the cut-off, now plus DUE_SLACK_MS, as ISO text): the
 * sites on the ladder whose re-check is due, as (url, name).
 */
export const DUE_SQL = `SELECT p.url, p.name FROM health_marks m JOIN portfolios p ON p.url = m.url
  WHERE ${ON_LADDER} AND m.pool_next_at <= ?
  ORDER BY m.pool_next_at`;

/** The same, counted: what the hourly workflow asks first, so an hour with nothing due costs one query. */
export const DUE_COUNT_SQL = `SELECT COUNT(*) AS n FROM (${DUE_SQL})`;

/** The cut-off DUE_SQL takes at `now`. */
export const dueCutoff = (now = new Date()) => iso(now.getTime() + DUE_SLACK_MS);

/**
 * SQL: the pool as the owner's admin page shows it: listed sites failing or
 * not working for not answering, with their ladder.
 */
export const POOL_SQL = `SELECT p.url, p.name, p.health, p.health_reason, p.health_checked_at,
    m.pool_stage, m.pool_started_at, m.pool_next_at, m.pool_since
  FROM health_marks m JOIN portfolios p ON p.url = m.url
  WHERE m.pool_stage IS NOT NULL AND p.delisted_at IS NULL AND p.health IN ('suspect', 'down')
  ORDER BY m.pool_stage DESC, m.pool_since, m.pool_started_at`;
