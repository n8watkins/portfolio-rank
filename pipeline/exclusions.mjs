// Our list wins: sites the health check confirmed down, and sites not working
// for LEAVE_AFTER_DAYS (./not-working.mjs), go into data/excluded.json with
// the reason and the evidence, and out of data/feed.json, so generate_feed.py
// keeps them out even while the community list still has them. The health
// workflow exports once a week (EXPORT_EVERY_DAYS) and commits both files
// through the same bot pull request flow as the daily upstream sync.
//
// data/excluded.json holds objects:
//   { url, name, reason, kind, removed, first_failed?, last_checked?, checks?,
//     decided_by?, evidence?, duplicate_of?, recheck_after? }
// kind: "down" (failed to load, parked, hijacked or blank; checked again
// monthly from its removal, see planDeadRecheck), "dead" (the name
// no longer resolves, or a 404 or broken deploy; checked again after
// recheck_after, see planDeadRecheck), "duplicate" (duplicate_of: the address
// kept), "not_portfolio" (graded so by the AI, settled by a code rule, or
// decided by the owner) or "owner_request" (a takedown). decided_by says who
// ("owner", "ai:<models>", "code:<rule>", "health:dns", "rule:duplicate") and
// evidence keeps what they said; /removed shows only kind, reason and date
// (lib/removed-kinds.mjs). Every reader matches on the URL alone
// (generate_feed.py norm_key, normKey here, discovery's normalizeCandidate),
// so the extra fields never change what is excluded. Plain URL strings (the
// old format) still work.

import fs from "fs";
import { APPLIED_REMOVAL_WHERE, checkSite, normKey } from "./health.mjs";
import { isBlockedReason, isBotWallReason } from "./capture-blocked.mjs";
import { AI_SAYS_NOT_PORTFOLIO } from "./portfolio-guard.mjs";
import { LEAVE_AFTER_DAYS, NOT_WORKING, VALID_MARKS, columnsOf, ensureHealthSchema, leavesList, notAnswering } from "./not-working.mjs";

// Refuse to exclude more than this share of the list in one go.
export const MAX_EXCLUDE_SHARE = 0.1;

export function kindOf(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("duplicate of")) return "duplicate";
  if (r.startsWith(AI_SAYS_NOT_PORTFOLIO)) return "not_portfolio";
  return "down";
}

/**
 * Who removed a "not a portfolio" site, from its latest applied "remove" row
 * in the review queue (lib/reviews/store.mjs), in data/excluded.json's shape
 * (#222): { decided_by: "owner" | "rule:...", evidence: { review, gemini?,
 * signals? } }, or null when no row decided it (the health check's own
 * failure). Never shown on the public Removed page.
 */
export async function removalDecider(db, url) {
  let r;
  try {
    r = (
      await db.execute({
        sql: `SELECT id, decided_by, verdicts, signals FROM status_reviews
              WHERE url = ? AND ${APPLIED_REMOVAL_WHERE()}
              ORDER BY decided_at DESC, id DESC LIMIT 1`,
        args: [url],
      })
    ).rows[0];
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return null;
    throw e;
  }
  if (!r) return null;
  const by = String(r.decided_by ?? "");
  const parse = (v) => {
    try {
      return v == null ? null : JSON.parse(String(v));
    } catch {
      return null;
    }
  };
  const gemini = parse(r.verdicts)?.gemini35?.solo?.reason ?? null;
  const signals = parse(r.signals);
  return {
    decided_by: by.startsWith("rule:") ? by : "owner",
    evidence: { review: Number(r.id), ...(gemini ? { gemini } : {}), ...(typeof signals?.score === "number" ? { signals: signals.score } : {}) },
  };
}

export const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

export const excludedUrl = (e) => (typeof e === "string" ? e : e?.url);

// A dead entry is checked again this long after the last check, and at most this many a run.
export const DEAD_RECHECK_DAYS = 91;
export const DEAD_RECHECK_LIMIT = 40;
// A "down" entry (three failed weekly checks) is checked again monthly (owner, 2026-11-16: a paused
// Vercel project or a missing deployment often comes back), under the same cap a run.
export const DOWN_RECHECK_DAYS = 30;
/** Days to the next check of an entry of this kind, or 0 for a kind that is never checked again. */
export const recheckDays = (kind) => (kind === "dead" ? DEAD_RECHECK_DAYS : kind === "down" ? DOWN_RECHECK_DAYS : 0);

const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * Whether a "down" entry was removed for not answering (the name, the
 * connection, TLS, an HTTP error, a paused or missing deployment): only those
 * can come back by answering again. One removed for what the site showed (a
 * blank page, a blocked capture, a parked page, a redirect to a profile) is
 * never re-checked: an answer says nothing about that.
 */
export const removedForNotAnswering = (reason) => notAnswering(reason);

/**
 * The day an excluded entry is due for its check, or null when it never is:
 * recheck_after when set; for a "down" entry removed for not answering
 * without one, DOWN_RECHECK_DAYS after its removal.
 */
export function recheckDue(e) {
  if (!e || typeof e !== "object" || !recheckDays(e.kind)) return null;
  if (e.kind === "down" && !removedForNotAnswering(e.reason)) return null;
  if (e.recheck_after) return String(e.recheck_after);
  if (e.kind === "down") return /^\d{4}-\d{2}-\d{2}$/.test(String(e.removed ?? "")) ? addDays(String(e.removed), DOWN_RECHECK_DAYS) : "";
  return "";
}

/**
 * Whether an excluded site is back: the same full check that removed it
 * (./health.mjs checkSite, with the browser's second opinion when `render`
 * is given) passes. Inconclusive is not back. Never throws.
 */
export const passesFullCheck =
  ({ render, fetchImpl } = {}) =>
  async (url, entry) => {
    try {
      return (await checkSite({ url, name: entry?.name ?? "" }, { render, ...(fetchImpl ? { fetchImpl } : {}) })).ok === true;
    } catch {
      return false;
    }
  };

/**
 * The dead and down entries due for their check (recheckDue on or before
 * today), at most `limit` a run: one that passes the full check now
 * (`answers(url, entry)`, by default passesFullCheck with `render`) leaves
 * the list (it returns with the next sync if the community list still has
 * it, and the weekly health check looks at it like any listed site); one
 * that doesn't gets its next check recheckDays(kind) later. Returns
 * { excluded, back: [urls], still: [urls] } without writing.
 */
export async function planDeadRecheck({ excluded, now = new Date(), render, answers = passesFullCheck({ render }), limit = DEAD_RECHECK_LIMIT }) {
  const day = now.toISOString().slice(0, 10);
  const due = excluded
    .filter((e) => {
      const at = recheckDue(e);
      return at != null && at <= day;
    })
    .slice(0, limit);
  const back = new Set();
  const still = new Set();
  for (const e of due) {
    if (await answers(e.url, e)) back.add(e);
    else still.add(e);
  }
  return {
    excluded: excluded.filter((e) => !back.has(e)).map((e) => (still.has(e) ? { ...e, last_checked: day, recheck_after: addDays(day, recheckDays(e.kind)) } : e)),
    back: [...back].map((e) => e.url),
    still: [...still].map((e) => e.url),
  };
}

// The full health check runs every night (owner, 2026-11-16), but the export to data/excluded.json
// (and the re-check of removed entries) is planned once a week, so its bot pull request does not
// become a daily one: a not-working site leaves the list only after 90 days anyway. Six days, not
// seven, so a run that starts a little early still plans.
//
// A planned export is kept in the cache table (PENDING_EXPORT_KEY) and applied to the files on every
// night until main carries it (its pull request merged): health.yml rewrites the pull request's
// branch from main whenever any data file changes (an owner removal on a Tuesday, say), so an export
// planned on Monday must be in Tuesday's files too. The export counts as done (EXPORT_KEY) only when
// it has landed; one that never lands within PENDING_EXPORT_MAX_DAYS is dropped and planned again.
export const EXPORT_EVERY_DAYS = 6;
export const PENDING_EXPORT_MAX_DAYS = 14;
const EXPORT_KEY = "health:last-export";
export const PENDING_EXPORT_KEY = "health:pending-export";

const cacheGet = async (db, k) => (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0] ?? null;
const cacheSet = (db, k, v, at) => db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at", args: [k, v, at] });

/** Whether a new weekly export may be planned at `now`: none landed in the last EXPORT_EVERY_DAYS, and none waiting to land. */
export async function exportDue(db, now = new Date()) {
  if (await cacheGet(db, PENDING_EXPORT_KEY)) return false;
  const row = await cacheGet(db, EXPORT_KEY);
  return !row || now.getTime() - Number(row.at) >= EXPORT_EVERY_DAYS * 86400000;
}

/** Records an export as done at `at` (it landed on main, or it had nothing to carry). */
export async function markExported(db, now = new Date()) {
  await cacheSet(db, EXPORT_KEY, now.toISOString(), now.getTime());
}

/**
 * A planned export applied to the files' contents (idempotent): entries
 * `added` (not already there) and dropped from the feed, entries `back`
 * removed, entries `still` failing given their new check dates.
 * plan: { added: [entry], back: [url], still: [{ url, last_checked, recheck_after }] }.
 */
export function applyExport({ excluded, feed }, plan) {
  const key = (u) => normKey(u);
  const back = new Set(plan.back.map(key));
  const still = new Map(plan.still.map((s) => [key(s.url), s]));
  const out = excluded
    .filter((e) => !back.has(key(excludedUrl(e))))
    .map((e) => {
      const s = typeof e === "object" ? still.get(key(e.url)) : null;
      return s ? { ...e, last_checked: s.last_checked, recheck_after: s.recheck_after } : e;
    });
  const have = new Set(out.map((e) => key(excludedUrl(e))));
  for (const a of plan.added) if (!have.has(key(a.url))) out.push(a);
  const drop = new Set(plan.added.map((a) => key(a.url)));
  return { excluded: out, feed: feed.filter((p) => !drop.has(key(p.url))) };
}

/** Whether main's data/excluded.json already carries a planned export (its pull request merged). */
export function exportLanded({ excluded }, plan) {
  const have = new Map(excluded.map((e) => [normKey(excludedUrl(e)), e]));
  return (
    plan.added.every((a) => have.has(normKey(a.url))) &&
    plan.back.every((u) => !have.has(normKey(u))) &&
    plan.still.every((s) => have.get(normKey(s.url))?.recheck_after === s.recheck_after)
  );
}

/**
 * The weekly export, kept until it lands. `excluded` and `feed` are main's
 * files as checked out. Plans a new export when one is due (planExclusions,
 * then planDeadRecheck with the full check), keeps it in the cache table and
 * returns the files with every export not yet on main applied, or null when
 * there is nothing to apply. A removed site that passes its re-check gets its
 * not-working marks due now, so once the daily sync lists it again the hourly
 * re-check brings it back at once instead of at its old monthly date.
 * `dryRun` plans and returns the same and writes nothing.
 * Returns { files, plan, planned, landed, held }.
 */
export async function weeklyExport({ db, excluded, feed, render, answers, now = new Date(), dryRun = false, log = () => {} }) {
  let pending = null;
  let landed = false;
  const row = await cacheGet(db, PENDING_EXPORT_KEY);
  if (row) {
    try {
      pending = JSON.parse(String(row.v));
    } catch {
      pending = null;
    }
    if (pending && exportLanded({ excluded }, pending)) {
      landed = true;
      if (!dryRun) {
        await markExported(db, new Date(Number(row.at)));
        await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [PENDING_EXPORT_KEY] });
      }
      pending = null;
    } else if (!pending || now.getTime() - Number(row.at) >= PENDING_EXPORT_MAX_DAYS * 86400000) {
      log(`export: the export planned ${new Date(Number(row.at)).toISOString().slice(0, 10)} never landed; planning again`);
      if (!dryRun) await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [PENDING_EXPORT_KEY] });
      pending = null;
    }
  }
  let planned = false;
  let held = [];
  if (!pending && (await exportDue(db, now))) {
    planned = true;
    const plan = await planExclusions({ db, excluded, feed, now, readOnly: dryRun });
    held = plan.held;
    const dead = await planDeadRecheck({ excluded: plan.excluded, now, render, ...(answers ? { answers } : {}) });
    const stillSet = new Set(dead.still);
    const still = dead.excluded.filter((e) => typeof e === "object" && stillSet.has(e.url)).map((e) => ({ url: e.url, last_checked: e.last_checked, recheck_after: e.recheck_after }));
    pending = { added: plan.added, back: dead.back, still };
    const empty = !pending.added.length && !pending.back.length && !pending.still.length;
    if (!dryRun) {
      if (dead.back.length) {
        await db.execute({
          sql: `UPDATE health_marks SET pool_next_at = ? WHERE url IN (${dead.back.map(() => "?").join(",")}) AND pool_stage IS NOT NULL`,
          args: [now.toISOString(), ...dead.back],
        });
      }
      if (empty) await markExported(db, now);
      else await cacheSet(db, PENDING_EXPORT_KEY, JSON.stringify(pending), now.getTime());
    }
    if (empty) pending = null;
  }
  return { files: pending ? applyExport({ excluded, feed }, pending) : null, plan: pending, planned, landed, held };
}

/**
 * Add confirmed-down listed rows to the exclusion list and drop them from the
 * feed. Returns { added: [...entries], excluded, feed } without writing; the
 * caller writes the files.
 */
export async function planExclusions({ db, excluded, feed, now = new Date(), readOnly = false }) {
  const have = new Set(excluded.map((e) => normKey(excludedUrl(e))));
  if (!readOnly) await ensureHealthSchema(db);
  // Marks that no longer describe the row count as none (./not-working.mjs VALID_MARKS); a database from
  // before the pool (a dry run) has none.
  const pooled = (await columnsOf(db, "health_marks")).has("pool_health");
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.status, p.reason, p.health_reason, p.health_fails, p.health_first_fail_at, p.health_checked_at,
              ${pooled ? `CASE WHEN ${VALID_MARKS()} THEN m.pool_stage END` : "NULL"} AS pool_stage,
              ${pooled ? `CASE WHEN ${VALID_MARKS()} THEN m.pool_since END` : "NULL"} AS pool_since
       FROM portfolios p ${pooled ? "LEFT JOIN health_marks m ON m.url = p.url" : ""}
       WHERE p.health = 'down' AND p.delisted_at IS NULL ORDER BY p.url`
    )
  ).rows;
  const onFeed = new Map(feed.map((p) => [p.url, p]));
  const day = now.toISOString().slice(0, 10);
  const added = [];
  // Down in the database but not removed, each with why: { url, why }.
  const held = [];
  for (const r of rows) {
    const url = String(r.url);
    if (!onFeed.has(url) || have.has(normKey(url))) continue;
    const kind = kindOf(r.health_reason);
    // A bot-walled site is never removed: it waits for the owner's review (owner, 2026-11-16).
    if (isBotWallReason(r.reason)) {
      held.push({ url, why: "its capture met a bot wall; it waits for the owner's review" });
      continue;
    }
    // Down for a blocked capture, but a good capture came in since (the nightly capture ran during the check).
    if (isBlockedReason(r.health_reason) && String(r.status ?? "") === "live") {
      held.push({ url, why: "a good capture replaced the blocked one this failure was about" });
      continue;
    }
    // Not working (./not-working.mjs): hidden, but on the list until LEAVE_AFTER_DAYS have passed, so a
    // site that answers again comes back by itself. A row confirmed down for not answering before the
    // pool existed (no pool marks) counts from its first failure.
    const inPool = kind === "down" && (Number(r.pool_stage ?? 0) === NOT_WORKING || (r.pool_stage == null && notAnswering(r.health_reason)));
    if (inPool) {
      const since = r.pool_since ?? r.health_first_fail_at;
      if (!leavesList(since == null ? null : String(since), now)) {
        held.push({ url, why: `not working since ${since == null ? "an unknown date" : String(since).slice(0, 10)}; it leaves the list after ${LEAVE_AFTER_DAYS} days` });
        continue;
      }
    }
    // A removal decided in the review queue says who decided, apart from the public reason.
    const decider = kind === "not_portfolio" ? await removalDecider(db, url) : null;
    // "Not a portfolio" leaves the list only through the review queue, with a record and Undo: never silently.
    if (kind === "not_portfolio" && !decider) {
      held.push({ url, why: "\"not a portfolio\" with no decision on record; the weekly check hands it to the review queue" });
      continue;
    }
    added.push({
      url,
      name: onFeed.get(url).name ?? (r.name == null ? url : String(r.name)),
      reason: String(r.health_reason ?? ""),
      kind,
      removed: day,
      first_failed: r.health_first_fail_at == null ? null : String(r.health_first_fail_at),
      last_checked: r.health_checked_at == null ? null : String(r.health_checked_at),
      checks: Number(r.health_fails ?? 0),
      ...(decider ?? {}),
    });
  }
  if (added.length > feed.length * MAX_EXCLUDE_SHARE) {
    throw new Error(
      `planExclusions: ${added.length} of ${feed.length} sites confirmed down, more than ${MAX_EXCLUDE_SHARE * 100}%; refusing (check the health check runs)`
    );
  }
  const drop = new Set(added.map((a) => normKey(a.url)));
  return {
    added,
    held,
    excluded: [...excluded, ...added],
    feed: feed.filter((p) => !drop.has(normKey(p.url))),
  };
}
