// The temporary pool and the archive (owner, 2026-11-16 and 2026-11-23: "if
// something is failing a health check, it doesn't go to review by me ... it
// gets automatically disabled and goes to a pool and that pool gets
// periodically checked. And after 90 days, it gets put into the archived
// section ... once a month to see if they pass any health checks").
//
// One ladder for every failed health check: a site that does not answer (the
// name does not resolve, nothing answers, TLS fails, an HTTP error), one that
// answers with the wrong thing (a parked or for-sale page, a blank page, a
// redirect to a social profile, a blocked capture of a site that never had a
// good one) and a duplicate of another entry. It leaves the AI's work at once,
// and the site itself a day later if it still fails. Nothing is deleted on
// the way: the row, the grade, the votes, the ratings and the screenshots
// stay, so a site that passes again comes back exactly as it was. Nobody is
// emailed about it and nothing goes to the owner's review queue.
//
//   live --first failed check--> failing (health 'suspect', stage 1):
//        out of grading, AI comparisons, polls and blog facts
//        (pipeline/roster.mjs AI_WORK) and of captures (ACTIVE, while these
//        marks hold); still shown
//   stage 1 --re-check about RECHECK_AFTER_MS later fails--> stage 2
//   stage 2 --re-check CONFIRM_AFTER_MS after the first failure fails-->
//        in the temporary pool (health 'down', stage 3, pool_since): hidden
//        from visitors everywhere (lib/hidden.mjs HIDDEN_WHERE: the list,
//        rankings, tiers, games), its profile answers not found
//        (lib/hidden.mjs GONE_WHERE)
//   in the pool: re-checked on POOL_CADENCE; after LEAVE_AFTER_DAYS it goes to
//        the archive (pipeline/exclusions.mjs planExclusions, data/excluded.json
//        through the weekly pull request), where the archive check
//        (archiveCheckDue) can still bring it back
//   any stage --a full check passes--> live, the ladder cleared, back exactly
//        as it was (recorded in health_returns)
//   any stage --a check that could not tell--> nothing changes (neither
//        advanced nor cleared); the re-check comes back after an hour, then
//        2, 4, 8... hours up to a day (UNCLEAR_MAX_WAIT_MS), and time unknown
//        counts toward the owner's 28-day alert (pipeline/health.mjs)
//   in the pool --any failure--> still in the pool, on its cadence
//
// A check counts as a stage's re-check only when it comes when that re-check
// is due (pool_next_at, less DUE_SLACK_MS): two failures on one bad day never
// skip a stage, so one bad night never hides a site. The re-checks are the
// same full check the nightly run makes (pipeline/health.mjs checkSite, with
// the browser's second opinion), run hourly for the sites that are due
// (pipeline/recheck.mjs, .github/workflows/recheck.yml); the nightly run
// leaves sites on the ladder to it.
//
// Never a failed check: a bot wall, a check that could not tell (a timeout, a
// dropped connection, a browser that did not start), a "not a portfolio"
// grade, and low portfolio signals (the code could not read the site; it
// stays listed). A removal decided in the review queue stays down with its
// reason (pipeline/health.mjs nextHealth). A new failure always starts the
// ladder at its own time. A row already 'down' with no ladder (from before
// the pool, or its marks voided) joins it as in the pool since its first
// failure, at its next failed check.
//
// A site in the pool goes to the archive only on a fresh failed check: its
// cadence brings a check at day LEAVE_AFTER_DAYS, and the export takes it
// only once a check on or after that day has failed (last_fail_at).
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
/**
 * The confirming re-check for a weak verdict (WEAK_VERDICT): a week after the
 * first failure (the 2026-11-23 review of #292, F1). A blank render, a blocked
 * capture, a redirect to a social profile and a duplicate can come from the
 * checker itself (a browser update, a CDN outage making single-page apps
 * render blank), so they get a week to clear; positive evidence (nothing
 * answers, an HTTP error, a parked or for-sale page) keeps the next day.
 */
export const CONFIRM_WEAK_AFTER_MS = 7 * DAY;
/**
 * A failure reason that is weak evidence (CONFIRM_WEAK_AFTER_MS): a blank
 * render, a blocked capture, a redirect to a social profile, a duplicate, and
 * (from the reading-fixes branch, fix/read-the-finished-page, pipeline/gate.mjs
 * parkedPage and pipeline/health.mjs checkSite) "not the site: ..." (a web
 * server's default page, a host's placeholder, a maintenance page, an app's
 * error page: temporary by nature) and "does not load (the browser's error
 * page)" (our browser's own view). A parking lander ("parking page: ...",
 * "parking phrase: ...") and a forward to a gambling site ("redirects to X, a
 * gambling site") stay positive evidence: the next day.
 */
export const WEAK_VERDICT = /^(renders blank|capture blocked: |redirects to \S+, not a portfolio|duplicate of |not the site: |does not load \(the browser's error page\))/;
/** The wait from the first failure to the confirming re-check, for a failure with `reason`. */
export const confirmAfterMs = (reason) => (WEAK_VERDICT.test(String(reason ?? "")) ? CONFIRM_WEAK_AFTER_MS : CONFIRM_AFTER_MS);
/**
 * DEFAULT: the drain (second review of #292): at most this many sites are
 * hidden in any 24 hours, oldest first failure first; the rest of a day's
 * confirmations wait at the stage before, still shown, and are hidden as the
 * allowance frees (36 dead sites: 20 one day, 16 the next). About 1% of the
 * 2,154 listed sites: real outages come a few at a time (21 really down sites
 * in one go on 2026-11-16 was the backlog of a first full check). No alert:
 * it is the normal pace, shown on /admin/health-pool.
 */
export const HIDE_PER_DAY = 20;
/**
 * DEFAULT: the drain for weak verdicts (third review of #292): at most this
 * many hidden in any 24 hours. A real blank page, a real duplicate or a real
 * placeholder is rare; many at once is far likelier to be our reader.
 */
export const HIDE_WEAK_PER_DAY = 5;
/**
 * DEFAULT: the freeze for faults on our side, measured by NEW first failures,
 * not by the backlog: more than SPIKE_NEW sites (about 5% of the list) entering
 * the ladder within SPIKE_WINDOW_MS, or more than SPIKE_CLASS of them for one
 * kind of reason (about 2%: a browser update that renders single-page apps
 * blank, a host-wide 5xx, a CDN outage), is a spike. A normal week brings a
 * handful of new failures; the benchmark's 60 random listed sites had one. The
 * sites from the spike are held at the stage before, still shown, and the
 * owner gets one alert; once the spike is over the hold lifts by itself, and
 * each held site still needs its full evidence (the next day, or a week for a
 * weak verdict) counted from the end of the hold, then the drain's pace.
 * HTTP errors are not exempt: a host-wide 5xx is exactly the many-at-once case.
 */
export const SPIKE_NEW = 100;
export const SPIKE_CLASS = 50;
export const SPIKE_WINDOW_MS = 2 * DAY;
/**
 * DEFAULT: the freeze for weak verdicts, per kind (reasonClass; third and
 * fourth reviews of #292). A fault in our reader that keeps going (blank
 * renders, 24 new a day for a week) never makes a 48-hour spike, and weak
 * verdicts wait 7 days anyway, so they are counted over SPIKE_WEAK_WINDOW_MS
 * (the 7-day confirmation and a day): more than SPIKE_WEAK new weak first
 * failures of one kind freezes that kind only, so a cluster of blank renders
 * leaves duplicates and placeholders moving. A frozen kind lifts when fewer
 * than SPIKE_WEAK of its held sites still fail (the reader fixed, or the sites
 * recovered); a site held WEAK_HOLD_MAX_MS is released into the weak drain
 * anyway (sites that really are blank forever), so no freeze holds forever.
 * The one owner alert stands while a kind is frozen and says so. 8 genuinely
 * blank sites in a week stay under it and drain at HIDE_WEAK_PER_DAY.
 */
export const SPIKE_WEAK = 50;
export const SPIKE_WEAK_WINDOW_MS = 8 * DAY;
export const WEAK_HOLD_MAX_MS = 14 * DAY;
/**
 * DEFAULT: the alert for a slow leak (fourth review of #292): a weak fault
 * under the freeze (6 new blank renders a day, 48 in 8 days) would hide real
 * portfolios at 5 a day with nothing said. More than WEAK_HIDES_ALERT weak
 * verdicts hidden within WEAK_HIDES_WINDOW_MS raises an owner alert, and holds
 * nothing. 8 genuinely blank sites in a week stay under it.
 */
export const WEAK_HIDES_ALERT = 15;
export const WEAK_HIDES_WINDOW_MS = 7 * DAY;
/** Whether a failure reason is weak evidence (WEAK_VERDICT). */
export const isWeakVerdict = (reason) => WEAK_VERDICT.test(String(reason ?? ""));
/** The kind of a failure reason, for the spike's per-kind count. */
export function reasonClass(reason) {
  const r = String(reason ?? "");
  if (/^does not load \(the browser's error page\)/.test(r)) return "browser-error-page";
  if (/^HTTP \d/.test(r)) return "http-error";
  if (notAnswering(r)) return "not-answering";
  if (/^renders blank/.test(r)) return "blank";
  if (/^capture blocked: /.test(r)) return "blocked-capture";
  if (/^duplicate of /.test(r)) return "duplicate";
  if (/^redirects to \S+, not a portfolio/.test(r)) return "social-redirect";
  if (/^not the site: /.test(r)) return "not-the-site";
  return "wrong-content";
}
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
 * a duplicate) is not. Both take the same ladder; the reason is only shown.
 */
export const notAnswering = (reason) => /^(HTTP \d|does not load|DNS|connect timeout|TLS|timeout|connection dropped)/.test(String(reason ?? ""));

/** notAnswering in SQL (never NULL) on the column `col` (tests/not-working.test.mjs keeps the two equal). */
export const NOT_ANSWERING_SQL = (col) =>
  `COALESCE(${col} GLOB 'HTTP [0-9]*' OR ${["does not load", "DNS", "connect timeout", "TLS", "timeout", "connection dropped"].map((w) => `substr(${col}, 1, ${w.length}) = '${w}'`).join(" OR ")}, 0)`;

// ---------------------------------------------------------------------------
// The archive: data/excluded.json entries of the health kinds (owner, 2026-11-23)

/** The excluded kinds the archive check looks at: removed for failing health checks. Never "not_portfolio", "duplicate" or "owner_request". */
export const ARCHIVE_KINDS = ["down", "dead"];
/** DEFAULT: the first archive checks, on these days after the site was archived, while its row is still kept (pipeline/roster.mjs PURGE_AFTER_DAYS, 30). */
export const ARCHIVE_FIRST_DAYS = [7, 14, 21];
/** The owner's number: then once a month. */
export const ARCHIVE_EVERY_DAYS = 30;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * Whether an excluded entry is in the archive: a health kind, and never a
 * removal the owner decided (decided_by "owner"). A "not a portfolio"
 * decision has its own kind (pipeline/exclusions.mjs kindOf), so it is never
 * here; neither is a duplicate or an owner's request. Those are never brought
 * back by a health check.
 */
export function inArchive(e) {
  if (!e || typeof e !== "object" || !ARCHIVE_KINDS.includes(String(e.kind ?? ""))) return false;
  return String(e.decided_by ?? "") !== "owner";
}

/** The archive check after one made on `day` (YYYY-MM-DD) of a site archived on `removed`: ARCHIVE_FIRST_DAYS, then every ARCHIVE_EVERY_DAYS. */
export function nextArchiveCheck(removed, day) {
  const first = DAY_RE.test(String(removed ?? "")) ? ARCHIVE_FIRST_DAYS.map((d) => addDays(String(removed), d)).find((d) => d > day) : null;
  return first ?? addDays(day, ARCHIVE_EVERY_DAYS);
}

/**
 * The day an archived entry is due for its check (YYYY-MM-DD; "" for now), or
 * null when it is not in the archive. The entry's recheck_after, but never
 * more than ARCHIVE_EVERY_DAYS after its last check (or its archiving), so an
 * entry written under an older, slower rule (91 days for "dead") is still
 * checked monthly. With neither date, the first of ARCHIVE_FIRST_DAYS.
 */
export function archiveCheckDue(e) {
  if (!inArchive(e)) return null;
  const base = [e.last_checked, e.removed].map((d) => String(d ?? "").slice(0, 10)).find((d) => DAY_RE.test(d)) ?? null;
  const monthly = base ? addDays(base, ARCHIVE_EVERY_DAYS) : null;
  const after = DAY_RE.test(String(e.recheck_after ?? "")) ? String(e.recheck_after) : null;
  if (after && monthly) return after < monthly ? after : monthly;
  if (after) return after;
  if (DAY_RE.test(String(e.removed ?? ""))) return addDays(String(e.removed), ARCHIVE_FIRST_DAYS[0]);
  return "";
}

/** Days the log of returns is kept (the owner's page shows the last RETURNS_SHOWN_DAYS). */
export const RETURNS_KEEP_DAYS = 120;
export const RETURNS_SHOWN_DAYS = 30;

/** The statement that drops the log's rows older than RETURNS_KEEP_DAYS. */
export const pruneReturns = (now = new Date()) => ({ sql: "DELETE FROM health_returns WHERE at < ?", args: [iso(now.getTime() - RETURNS_KEEP_DAYS * DAY)] });

/**
 * Statements recording that sites came back (`from`: "pool" or "archive"):
 * [{ url, at, reason, since, hidden }], and the prune.
 */
export function returnStatements(items, from, now = new Date()) {
  if (!items.length) return [];
  return [
    ...items.map((i) => ({
      sql: "INSERT INTO health_returns (url, at, from_where, reason, since, hidden) VALUES (?, ?, ?, ?, ?, ?)",
      args: [i.url, i.at ?? now.toISOString(), from, i.reason ?? null, i.since ?? null, i.hidden ? 1 : 0],
    })),
    pruneReturns(now),
  ];
}


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
  return {
    stage,
    startedAt: str(row.pool_started_at),
    nextAt: str(row.pool_next_at),
    since: str(row.pool_since),
    unclear: Number(row.pool_unclear ?? 0),
    // The first failure of this run of failures, never moved (the spike counts it); and why a site waits at
    // stage 2 past its confirming check: "drain" (the day's allowance is used) or "freeze" (a spike).
    firstAt: str(row.pool_first_at) ?? str(row.pool_started_at),
    held: str(row.pool_held),
    // When a weak freeze first held it, kept while it stays held (WEAK_HOLD_MAX_MS).
    heldAt: str(row.pool_held_at),
  };
}

/**
 * One failed check (any kind: the site does not answer, or answers with the
 * wrong thing, or duplicates another entry). prev: { health,
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
      // firstAt: a row already failing with no ladder (the old weekly-counted rule's 'suspect', on release
      // night) keeps its original first failure, so that one-time restart is never counted as a spike of new
      // failures; its evidence (startedAt) starts now like any first failure.
      pool: { stage: FAILING, startedAt: iso(t), nextAt: iso(t + RECHECK_AFTER_MS), since: null, unclear: 0, firstAt: prev?.health === "suspect" && prev?.firstFailAt ? String(prev.firstFailAt) : iso(t), held: null },
    };
  }
  const due = pool.nextAt == null || t >= ms(pool.nextAt) - DUE_SLACK_MS;
  let next = { ...pool, unclear: 0 };
  if (due) {
    // The confirming re-check: the next day, or a week after the first failure for a weak verdict.
    const confirmAt = ms(pool.startedAt) + confirmAfterMs(result.reason);
    if (pool.stage === FAILING) {
      // The first re-check failed: the confirming one comes later (and never within the hour).
      next = { ...next, stage: RECHECKED, nextAt: iso(Math.max(confirmAt, t + RECHECK_AFTER_MS)) };
    } else if (pool.stage === RECHECKED && t < confirmAt - DUE_SLACK_MS) {
      // Due on the next day's terms, but this failure is a weak verdict: it waits for its own confirming day.
      // A site held by a freeze is checked daily meanwhile, so the freeze sees it recover (a weak freeze
      // lifts only when most of its held sites pass again).
      const daily = pool.held === "freeze" || pool.held === "freeze-weak";
      next = { ...next, nextAt: iso(daily ? Math.min(confirmAt, t + DAY) : confirmAt) };
    } else if (pool.stage === RECHECKED) {
      // Still failing on its confirming day: into the temporary pool.
      next = { ...next, stage: NOT_WORKING, since: iso(t), nextAt: iso(notWorkingNext(t, t)) };
    } else {
      next = { ...next, stage: NOT_WORKING, nextAt: iso(notWorkingNext(ms(pool.since ?? pool.startedAt), t)) };
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

/**
 * The next check of a site not working since `since` (ms), checked at `t`:
 * POOL_CADENCE, but never past day LEAVE_AFTER_DAYS, so the check that may
 * take it off the list is made on that day, not up to a month later.
 */
export function notWorkingNext(since, t) {
  const next = t + cadenceDays((t - since) / DAY) * DAY;
  const leave = since + LEAVE_AFTER_DAYS * DAY;
  return t < leave && next > leave ? leave : next;
}

/** Whether a site not working since `since` has been so for LEAVE_AFTER_DAYS by `now` (it then leaves the list). */
export const leavesList = (since, now = new Date()) => Number.isFinite(ms(since)) && now.getTime() - ms(since) >= LEAVE_AFTER_DAYS * DAY;

/**
 * Whether a not-working site may leave the list: not working LEAVE_AFTER_DAYS,
 * and its last failed check (`lastFailAt`) made on or after that day, so a
 * site never leaves on a check weeks old (one that passed since is back on
 * the list already).
 */
export const leavesOnFreshFailure = (since, lastFailAt) => Number.isFinite(ms(since)) && Number.isFinite(ms(lastFailAt)) && ms(lastFailAt) >= ms(since) + LEAVE_AFTER_DAYS * DAY - DUE_SLACK_MS;

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
 * SQL (one argument: the cut-off, as ISO text): the sites that came back
 * since the cut-off, newest first, for the owner's Health pool page.
 */
export const RETURNS_SQL = `SELECT url, at, from_where, reason, since, hidden FROM health_returns WHERE at >= ? ORDER BY at DESC, id DESC`;

/**
 * SQL: listed sites whose listed address failed while the site answered at its
 * own www or https address (pipeline/health.mjs sameSiteAddress), for the
 * owner's Health pool page: "listed address is unreliable".
 */
export const ANSWERS_ELSEWHERE_SQL = `SELECT p.url, p.name, m.answers_at, p.health_checked_at FROM health_marks m JOIN portfolios p ON p.url = m.url
  WHERE m.answers_at IS NOT NULL AND p.delisted_at IS NULL ORDER BY p.url`;

/**
 * SQL: the pool as the owner's admin pages show it: listed sites failing (not
 * hidden yet) or in the temporary pool (hidden), with their ladder.
 */
export const POOL_SQL = `SELECT p.url, p.name, p.health, p.health_reason, p.health_checked_at, p.reason AS capture_reason,
    m.pool_stage, m.pool_started_at, m.pool_next_at, m.pool_since, m.pool_held
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

/** health_marks.purge_pending: the profile was taken away (it must answer not found), or it came back (it must answer). */
export const PURGE_GONE = 1;
export const PURGE_BACK = 2;

/**
 * Brings the cached copies of profiles the health check hid or showed in line
 * with the site (health_marks.purge_pending, set by the write that changed
 * the row; the Worker's hourly Cron Trigger, worker/index.ts). A profile page
 * is kept twice: by Next's incremental cache (5 minutes, served stale once
 * while it renders again) and at the edge (a day). So each tick, for each
 * pending profile:
 *   0. `revalidate(urls)` asks the app to drop its own cached copy (Next's
 *      path revalidation), so the next render is the page as it is now;
 *   1. `origin(url)` asks the app itself, past the edge, for the page and
 *      returns its status: that request is also what makes Next render a
 *      stale copy again;
 *   2. `purge(urls)` drops the edge's copies, at most PURGE_BATCH a call
 *      (CachedPages.purgeTags purges at most 100 tags, worker/tier-purge.ts);
 *   3. the mark is cleared only when the purge went through AND the origin
 *      already answered as it should (not found for a hidden profile, the
 *      page for one that came back). Otherwise the next tick does it all
 *      again, so a stale copy the edge took in between never lasts a day.
 * Without `origin` (no app to ask), a purge that went through clears the mark.
 * Returns { purged: [urls], failed: [urls], waiting: [urls] }.
 */
export const PURGE_BATCH = 100;
/**
 * @param {{ execute: Function }} db
 * @param {{ purge: (urls: string[]) => Promise<boolean> | boolean, origin?: (url: string) => Promise<number> | number, revalidate?: (urls: string[]) => Promise<unknown>, limit?: number }} opts
 */
export async function purgeGoneProfiles(db, { purge, origin, revalidate, limit = 500 }) {
  let rows;
  try {
    rows = (await db.execute({ sql: "SELECT url, purge_pending FROM health_marks WHERE purge_pending > 0 ORDER BY url LIMIT ?", args: [limit] })).rows;
  } catch (e) {
    if (/no such (table|column)/i.test(String(e?.message ?? e))) return { purged: [], failed: [], waiting: [] };
    throw e;
  }
  const want = new Map(rows.map((r) => [String(r.url), Number(r.purge_pending)]));
  const urls = [...want.keys()];
  // 0. The app's own copies first (best effort: the origin check below decides).
  if (revalidate && urls.length) {
    for (let i = 0; i < urls.length; i += PURGE_BATCH) {
      try {
        await revalidate(urls.slice(i, i + PURGE_BATCH));
      } catch {
        // The origin's answer below decides whether the mark is cleared.
      }
    }
  }
  // 1. The origin's answer, before the purge (it is also what renders a stale copy again).
  const settled = new Set();
  for (const url of urls) {
    if (!origin) {
      settled.add(url);
      continue;
    }
    let status = 0;
    try {
      status = Number(await origin(url));
    } catch {
      status = 0;
    }
    if (want.get(url) === PURGE_GONE ? status === 404 : status === 200) settled.add(url);
  }
  const purged = [];
  const failed = [];
  const waiting = [];
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
    purged.push(...part);
    const done = part.filter((u) => settled.has(u));
    waiting.push(...part.filter((u) => !settled.has(u)));
    if (done.length) await db.execute({ sql: `UPDATE health_marks SET purge_pending = 0 WHERE url IN (${done.map(() => "?").join(",")})`, args: done });
  }
  return { purged, failed, waiting };
}
