// The not-working pool (owner, 2026-11-16): a listed site that stops
// answering (paused hosting, a deleted deployment, a dead domain, a refused
// connection) leaves the AI's work at once, and the site itself a day later
// if it is still not answering. Nothing is deleted on the way: the row, the
// grade, the votes, the ratings and the screenshots stay, so a site that
// answers again comes back exactly as it was. Nobody is emailed about it.
//
//   live --first failed check--> failing (health 'suspect', stage 1):
//        out of grading, AI comparisons, polls and blog facts
//        (pipeline/roster.mjs AI_WORK) and of captures (ACTIVE, while these
//        marks hold); still shown
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
//   any stage --a check that could not tell--> nothing changes (neither
//        advanced nor cleared); the re-check comes back after an hour, then
//        2, 4, 8... hours up to a day (UNCLEAR_MAX_WAIT_MS), and time unknown
//        counts toward the owner's 28-day alert (pipeline/health.mjs)
//   stage 1 or 2 --the page answers, with the wrong thing (parked, blank)-->
//        off this ladder, onto the weekly-counted rule from that failure;
//   not working --any failure--> still not working, on its cadence
//
// A check counts as a stage's re-check only when it comes when that re-check
// is due (pool_next_at, less DUE_SLACK_MS): two failures on one bad day never
// skip a stage. The re-checks are the same full check the nightly run makes
// (pipeline/health.mjs checkSite, with the browser's second opinion), run
// hourly for the sites that are due (pipeline/recheck.mjs,
// .github/workflows/recheck.yml); the nightly run leaves sites on the ladder
// to it.
//
// Only a site that does not answer joins the ladder (notAnswering). One that
// answers with the wrong thing (a parked page, a blank page, a redirect to a
// social profile, a duplicate, a blocked capture) is on the weekly-counted
// rule of pipeline/health.mjs, a bot wall or a check that could not tell is
// never a failure at all, and a row 'down' for any reason stays down until a
// check passes (pipeline/health.mjs nextHealth). A new failure always starts the ladder at
// its own time; only the one-time adoption of rows that were failing for not
// answering when the pool shipped (adoptLegacy) starts it earlier.
//
// The state lives in portfolios.health ('suspect' while failing, 'down' when
// not working, which every reader of the hidden rule already understands)
// and in health_marks' pool_* columns (lib/pipeline-schema.mjs). The marks
// count only while they match the row: they record the health and the
// health_checked_at they were written with (VALID_MARKS), so a writer that
// changes the row without knowing about the pool (the review queue's
// confirm or remove) makes them void instead of leaving a stale schedule.
//
// No imports beyond the schema: pipeline/recheck-due.mjs runs this file's
// count query in the hourly workflow before `npm ci`, and the Worker imports
// purgeGoneProfiles.

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
/** After a re-check that could not tell, the next one waits RECHECK_AFTER_MS, then twice that each time, up to this. */
export const UNCLEAR_MAX_WAIT_MS = 1 * DAY;
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

/** The same rule in SQL (never NULL) on a reason column: tests/not-working.test.mjs keeps the two equal. */
export const NOT_ANSWERING_SQL = (col) =>
  `(${["HTTP [0-9]*", "does not load*", "DNS*", "connect timeout*", "TLS*", "timeout*", "connection dropped*"].map((g) => `COALESCE(${col}, '') GLOB '${g}'`).join(" OR ")})`;

/** Days between re-checks of a site not working for `ageDays` days (POOL_CADENCE). */
export const cadenceDays = (ageDays) => (POOL_CADENCE.find((c) => ageDays < c.untilDays) ?? POOL_CADENCE[POOL_CADENCE.length - 1]).everyDays;

/** The wait before the next re-check after `unclear` re-checks in a row that could not tell (1 h, 2 h, 4 h ... a day). */
export const unclearWaitMs = (unclear) => Math.min(RECHECK_AFTER_MS * 2 ** Math.max(0, Number(unclear) - 1), UNCLEAR_MAX_WAIT_MS);

const iso = (ms) => new Date(ms).toISOString();
const ms = (s) => (s == null ? NaN : Date.parse(String(s)));

/**
 * SQL condition (never NULL) on health_marks `m` and portfolios `p`: the
 * marks are on a ladder and still describe the row, i.e. its health and
 * health_checked_at are the ones written with them. Anything else that
 * changed the row since (the review queue's confirm or remove, a hand edit)
 * voids them. An Undo that puts the row back exactly makes them hold again,
 * as they did before.
 */
export const VALID_MARKS = (m = "m", p = "p") =>
  `(${m}.pool_stage IS NOT NULL AND ${m}.pool_health IS ${p}.health AND ${m}.pool_checked_at IS ${p}.health_checked_at)`;

/** A site's ladder from a row read with the pool_* columns and `pool_valid` (VALID_MARKS), or null when it is on none. */
export function poolOf(row) {
  const stage = Number(row?.pool_stage ?? 0);
  if (!stage || Number(row?.pool_valid ?? 0) !== 1) return null;
  const str = (v) => (v == null ? null : String(v));
  return { stage, startedAt: str(row.pool_started_at), nextAt: str(row.pool_next_at), since: str(row.pool_since), unclear: Number(row.pool_unclear ?? 0) };
}

/**
 * One check that failed because the site does not answer. prev: { health,
 * fails, firstFailAt, lastFailAt, reason, pool } (pool: poolOf, or null).
 * Returns the new { health, fails, firstFailAt, lastFailAt, reason, pool }.
 * A site not on the ladder joins it at stage 1 now; one on it advances when
 * its re-check is due, and otherwise only its reason changes.
 */
export function failOnLadder(prev, result, now = new Date()) {
  const t = now.getTime();
  const pool = prev?.pool ?? null;
  if (!pool) {
    // The first failure: out of the AI's work now, re-checked in about an hour.
    return {
      health: "suspect",
      fails: 1,
      firstFailAt: iso(t),
      lastFailAt: iso(t),
      reason: result.reason,
      pool: { stage: FAILING, startedAt: iso(t), nextAt: iso(t + RECHECK_AFTER_MS), since: null, unclear: 0 },
    };
  }
  const due = pool.nextAt == null || t >= ms(pool.nextAt) - DUE_SLACK_MS;
  let next = { ...pool, unclear: 0 };
  if (due) {
    if (pool.stage === FAILING) {
      // The first re-check failed: the confirming one comes the next day (and never within the hour).
      next = { ...next, stage: RECHECKED, nextAt: iso(Math.max(ms(pool.startedAt) + CONFIRM_AFTER_MS, t + RECHECK_AFTER_MS)) };
    } else if (pool.stage === RECHECKED) {
      // Still failing the next day: not working.
      next = { ...next, stage: NOT_WORKING, since: iso(t), nextAt: iso(t + cadenceDays(0) * DAY) };
    } else {
      const since = ms(pool.since ?? pool.startedAt);
      next = { ...next, stage: NOT_WORKING, nextAt: iso(t + cadenceDays((t - since) / DAY) * DAY) };
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

/**
 * A check of a site on the ladder that could not tell (a timeout, a dropped
 * connection, a bot wall). Neither advances nor clears the ladder: the health
 * and the stage stay. When the re-check was due, the next one waits
 * unclearWaitMs (1 h, then 2, 4 ... up to a day) instead of coming every hour
 * forever. `reason` is what to record (the one it had).
 */
export function holdOnLadder(prev, reason, now = new Date()) {
  const t = now.getTime();
  const pool = prev.pool;
  const due = pool.nextAt == null || t >= ms(pool.nextAt) - DUE_SLACK_MS;
  const unclear = due ? pool.unclear + 1 : pool.unclear;
  return {
    health: prev.health,
    fails: Number(prev.fails ?? 0),
    firstFailAt: prev.firstFailAt ?? null,
    lastFailAt: prev.lastFailAt ?? null,
    reason,
    pool: { ...pool, unclear, nextAt: due ? iso(t + unclearWaitMs(unclear)) : pool.nextAt },
  };
}

/** Whether a site not working since `since` has been so for LEAVE_AFTER_DAYS by `now` (it then leaves the list). */
export const leavesList = (since, now = new Date()) => Number.isFinite(ms(since)) && now.getTime() - ms(since) >= LEAVE_AFTER_DAYS * DAY;

/** Creates health_marks with the pool's columns and indexes (idempotent; lib/schema.mjs runs the same). */
export async function ensureHealthSchema(db) {
  await applyTables(db, HEALTH_TABLES, HEALTH_COLUMNS);
  for (const sql of HEALTH_AFTER) await db.execute(sql);
}

/** SQL condition on health_marks `m` joined to portfolios `p`: the site is on the ladder, so the hourly re-check owns it. */
const ON_LADDER = `${VALID_MARKS()} AND m.pool_next_at IS NOT NULL AND p.delisted_at IS NULL AND p.health IN ('suspect', 'down')`;

/**
 * SQL: the listed sites on the ladder (url), which the nightly full run
 * leaves to the hourly re-check. A site whose row changed under the marks (set
 * back to live by hand, confirmed or removed in the review queue) is not.
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
  WHERE ${VALID_MARKS()} AND p.delisted_at IS NULL AND p.health IN ('suspect', 'down')
  ORDER BY m.pool_stage DESC, m.pool_since, m.pool_started_at`;

/**
 * SQL (one argument: the cut-off, now less UNKNOWN days, as ISO text): sites
 * on the ladder the check has not been able to tell about since before the
 * cut-off, for the owner's alert (pipeline/health.mjs). The nightly run skips
 * them, so the alert is read from the marks, not from one run's results.
 */
export const LADDER_UNKNOWN_SQL = `SELECT p.url, p.health_reason, m.unknown_since FROM health_marks m JOIN portfolios p ON p.url = m.url
  WHERE ${ON_LADDER} AND m.unknown_since IS NOT NULL AND m.unknown_since <= ? ORDER BY p.url`;

// ---------------------------------------------------------------------------
// The one-time adoption of rows failing when the pool shipped

/** The cache key that says the adoption ran (once per database). */
export const ADOPTED_KEY = "health:pool-adopted";

/**
 * The rows that were failing for not answering when the pool shipped:
 * listed, 'suspect' or 'down' with a not-answering reason, and no ladder
 * marks. Each joins the ladder from its own first failure, due now:
 *   - 'suspect' at stage 1 (its next failed check counts as the hour's
 *     re-check, and the one an hour after that hides it);
 *   - 'down' (confirmed by the old three-week rule) at stage 3, not working
 *     since its first failure, so it leaves the list 90 days after that.
 * Returns [{ url, health, marks }] without writing; `readOnly` reads columns
 * that may not exist yet (a database before this release) as empty.
 */
export async function legacyRows(db, now = new Date()) {
  const marks = await columnsOf(db, "health_marks");
  const join = marks.has("pool_stage") ? "LEFT JOIN health_marks m ON m.url = p.url" : "";
  const noMarks = marks.has("pool_stage") ? "AND m.pool_stage IS NULL" : "";
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.health, p.health_reason, p.health_first_fail_at, p.health_checked_at FROM portfolios p ${join}
       WHERE p.delisted_at IS NULL AND p.health IN ('suspect', 'down') AND ${NOT_ANSWERING_SQL("p.health_reason")} ${noMarks} ORDER BY p.url`
    )
  ).rows;
  const t = now.toISOString();
  return rows.map((r) => {
    const health = String(r.health);
    const first = r.health_first_fail_at != null && Number.isFinite(ms(r.health_first_fail_at)) ? String(r.health_first_fail_at) : t;
    const down = health === "down";
    return {
      url: String(r.url),
      name: r.name == null ? "" : String(r.name),
      health,
      reason: String(r.health_reason ?? ""),
      marks: {
        pool_stage: down ? NOT_WORKING : FAILING,
        pool_started_at: first,
        pool_next_at: t,
        pool_since: down ? first : null,
        pool_health: health,
        pool_checked_at: r.health_checked_at == null ? null : String(r.health_checked_at),
        pool_unclear: 0,
      },
    };
  });
}

/**
 * Runs the adoption once per database (ADOPTED_KEY): writes the marks of
 * legacyRows. Returns the adopted rows ([] when it ran before). `dryRun`
 * writes nothing and returns what it would adopt.
 */
export async function adoptLegacy(db, { now = new Date(), dryRun = false } = {}) {
  const done = await db.execute({ sql: "SELECT 1 FROM cache WHERE k = ?", args: [ADOPTED_KEY] }).catch(() => ({ rows: [] }));
  if (done.rows.length) return [];
  const rows = await legacyRows(db, now);
  if (dryRun) return rows;
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO health_marks (url, pool_stage, pool_started_at, pool_next_at, pool_since, pool_health, pool_checked_at, pool_unclear)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(url) DO UPDATE SET pool_stage = excluded.pool_stage, pool_started_at = excluded.pool_started_at,
            pool_next_at = excluded.pool_next_at, pool_since = excluded.pool_since, pool_health = excluded.pool_health,
            pool_checked_at = excluded.pool_checked_at, pool_unclear = 0`,
    args: [r.url, r.marks.pool_stage, r.marks.pool_started_at, r.marks.pool_next_at, r.marks.pool_since, r.marks.pool_health, r.marks.pool_checked_at],
  }));
  stmts.push({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [ADOPTED_KEY, JSON.stringify({ adopted: rows.length }), now.getTime()] });
  await db.batch(stmts, "write");
  return rows;
}

/** The columns a table has (empty when it does not exist). */
export async function columnsOf(db, table) {
  try {
    return new Set((await db.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// The edge cache

/**
 * Purges the cached profiles of sites the health check took off the site
 * (health_marks.purge_pending, set when a write made the row 'down') and
 * clears the mark only when the purge worked, so a failed one is tried again
 * the next hour (the Worker's hourly Cron Trigger, worker/index.ts).
 * `purge(urls)` resolves true when the purge went through; it is called with
 * at most PURGE_BATCH urls (CachedPages.purgeTags purges at most 100 tags a
 * call, as worker/tier-purge.ts knows), and only a batch that went through is
 * cleared. Returns { purged: [urls], failed: [urls] }.
 */
export const PURGE_BATCH = 100;
export async function purgeGoneProfiles(db, { purge, limit = 500 }) {
  let rows;
  try {
    rows = (await db.execute({ sql: "SELECT url FROM health_marks WHERE purge_pending = 1 ORDER BY url LIMIT ?", args: [limit] })).rows;
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message ?? e))) return { purged: [], failed: [] };
    throw e;
  }
  const urls = rows.map((r) => String(r.url));
  const purged = [];
  const failed = [];
  for (let i = 0; i < urls.length; i += PURGE_BATCH) {
    const part = urls.slice(i, i + PURGE_BATCH);
    let ok = false;
    try {
      ok = Boolean(await purge(part));
    } catch {
      ok = false;
    }
    if (!ok) {
      failed.push(...part);
      continue;
    }
    await db.execute({ sql: `UPDATE health_marks SET purge_pending = 0 WHERE url IN (${part.map(() => "?").join(",")})`, args: part });
    purged.push(...part);
  }
  return { purged, failed };
}
