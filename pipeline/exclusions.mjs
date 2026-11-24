// Our list wins: sites in the temporary pool for LEAVE_AFTER_DAYS
// (./not-working.mjs) go to the archive, data/excluded.json, with the reason
// and the evidence, and out of data/feed.json, so generate_feed.py keeps them
// out even while the community list still has them; so do removals decided in
// the review queue ("not a portfolio"). The health workflow exports once a
// week (EXPORT_EVERY_DAYS) and commits the files through the same bot pull
// request flow as the daily upstream sync.
//
// data/excluded.json holds objects:
//   { url, name, reason, kind, removed, first_failed?, last_checked?, checks?,
//     decided_by?, evidence?, duplicate_of?, recheck_after? }
// kind: "down" (archived after 90 days failing health checks: does not load,
// parked, blank, a social redirect, a blocked capture) and "dead" (the name no
// longer resolves, or a 404 or broken deploy): the archive, checked again on
// days 7, 14 and 21 after archiving and then monthly (./not-working.mjs
// archiveCheckDue, planDeadRecheck); one that passes comes back as a new site,
// its old rows moved out of its way (./archive-return.mjs); "duplicate" (duplicate_of: the address
// kept), "not_portfolio" (graded so by the AI, settled by a code rule, or
// decided by the owner) or "owner_request" (a takedown): never checked again.
// decided_by says who
// ("owner", "ai:<models>", "code:<rule>", "health:dns", "rule:duplicate") and
// evidence keeps what they said; /removed shows only kind, reason and date
// (lib/removed-kinds.mjs). Every reader matches on the URL alone
// (generate_feed.py norm_key, normKey here, discovery's normalizeCandidate),
// so the extra fields never change what is excluded. Plain URL strings (the
// old format) still work.

import { APPLIED_REMOVAL_WHERE, carriesName, checkSite, mapPool, normKey } from "./health.mjs";
import { excludedUrl, readJson } from "./list-util.mjs";
import { capturedBlocked, isBlockedReason, isBotWallReason } from "./capture-blocked.mjs";
import { SIGNAL_NAMES, STRONG_SIGNALS, notPortfolioReason } from "./portfolio-guard.mjs";
import { LEFT_LIST } from "./build-feed.mjs";
import { retireArchivedSite } from "./archive-return.mjs";
import {
  ARCHIVE_EVERY_DAYS,
  ARCHIVE_FIRST_DAYS,
  LEAVE_AFTER_DAYS,
  NOT_WORKING,
  VALID_MARKS,
  archiveCheckDue,
  columnsOf,
  ensureHealthSchema,
  leavesOnFreshFailure,
  nextArchiveCheck,
  returnStatements,
} from "./not-working.mjs";

// Refuse to exclude more than this share of the list in one go.
export const MAX_EXCLUDE_SHARE = 0.1;

export function kindOf(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("duplicate of")) return "duplicate";
  if (notPortfolioReason(r)) return "not_portfolio";
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

export { excludedUrl, readJson };

// The archive check (owner, 2026-11-23: "once a month to see if they pass any health checks"): at most this
// many archived entries a run, this many at a time as the main check does, and none starts after this long,
// so the nightly job (health.yml, 120 minutes) is never at risk: the rest wait for the next run. The checks
// are planned with the weekly export, so each lands within a week of its day (./not-working.mjs
// archiveCheckDue: days 7, 14 and 21 after archiving, while the site's row is still kept, then monthly).
export const DEAD_RECHECK_LIMIT = 40;
export const DEAD_RECHECK_CONCURRENCY = 8;
export const DEAD_RECHECK_BUDGET_MS = 15 * 60000;
export { ARCHIVE_EVERY_DAYS, ARCHIVE_FIRST_DAYS };

/**
 * The day an excluded entry is due for its archive check, or null when it
 * never is (./not-working.mjs archiveCheckDue: only "down" and "dead", never
 * a removal the owner or a "not a portfolio" decision made).
 */
export const recheckDue = archiveCheckDue;

/**
 * Whether an excluded site is back: the same full check that removed it
 * (./health.mjs checkSite, with the browser's second opinion when `render`
 * is given) passes. Inconclusive is not back. Never throws.
 */
/** An excluded entry without its last archive check's finding (each check records its own, or none). */
const withoutFound = (e) => {
  const copy = { ...e };
  delete copy.found;
  return copy;
};

/**
 * THE HOOK for detectors that veto an archive return (third review of #292):
 * each takes the passing checkSite result (./health.mjs: ok, finalUrl, title,
 * pageText, heading, links, signals, moved, hijack) and returns why the entry
 * stays archived, or null. The first that answers wins; its answer is shown on
 * /admin/health-pool as what was found. A failing verdict (a parked page, a
 * gambling forward, "not the site: ...") never reaches here: checkSite already
 * failed it. The reading-fixes branch (fix/read-the-finished-page) adds its
 * own here: a hijack flag on a same-site page, a parking lander that passed.
 */
export const RETURN_VETOES = [
  // A forward to another domain that carries none of the person's name (./health.mjs redirectVerdict).
  (r) => (r?.moved && r?.hijack ? "answers, but it forwards to another domain that carries none of the person's name" : null),
];
/** Why a passing archived entry still stays archived (RETURN_VETOES), or null. */
export const returnVeto = (r) => {
  for (const veto of RETURN_VETOES) {
    const why = veto(r);
    if (why) return why;
  }
  return null;
};

export const passesFullCheck =
  ({ render, fetchImpl } = {}) =>
  async (url, entry) => {
    let r;
    try {
      r = await checkSite({ url, name: entry?.name ?? "" }, { render, ...(fetchImpl ? { fetchImpl } : {}) });
    } catch {
      return false;
    }
    if (r?.ok !== true) return false;
    const found = { day: new Date().toISOString().slice(0, 10), final_url: r.finalUrl ?? url, title: String(r.title ?? "").slice(0, 120) };
    // A portfolio again, not a re-registered domain serving something else (#292 reviews, F4 and the third
    // review): the page carries the listed person's name (the page's own words only: a re-registered domain
    // keeps the name in its address), or the code finds strong portfolio signals on it (a person who signs
    // with a handle, "@mrashid" for Mohammed Al-Rashid). An archive return starts fresh and goes through
    // the door (./archive-return.mjs, lib/reviews/door.mjs), so a page naming the person that is not their
    // portfolio is judged there. Otherwise it stays archived, with what was found for the owner.
    const named = carriesName(entry?.name ?? "", { title: r.title, text: r.pageText, heading: r.heading });
    const score = Number(r.signals?.score ?? 0);
    if (!named && !(score >= STRONG_SIGNALS)) {
      return { ok: false, found: { ...found, why: `answers, but the page carries neither the listed person's name nor strong portfolio signals (${score} of ${SIGNAL_NAMES.length})` } };
    }
    const veto = returnVeto(r);
    if (veto) return { ok: false, found: { ...found, why: veto } };
    // Archived for a capture that never showed the site: back only when the page itself shows one by the
    // capture's own rule (./capture-blocked.mjs capturedBlocked on its words and links, so a short page that
    // links out still shows a site), so a gate or a loader that is still there does not cycle through the
    // list and the archive (#292 review, F3).
    if (isBlockedReason(entry?.reason) && capturedBlocked({ text: r.pageText ?? "", title: r.title ?? "", ...(r.links ?? {}) }) !== null) {
      return { ok: false, found: { ...found, why: "answers, but the page still does not show the site" } };
    }
    return true;
  };

/**
 * The archived entries due for their check (recheckDue on or before today),
 * at most `limit` a run: one that passes the full check now
 * (`answers(url, entry)`, by default passesFullCheck with `render`) leaves
 * the archive (it returns with the next sync, from the community list or
 * from our own record of it, applyExport, and the nightly health check looks
 * at it like any listed site); one that doesn't gets its next check
 * (nextArchiveCheck). An inconclusive check is not a pass. The checks run
 * `concurrency` at a time (a dead server takes a minute or two to give up),
 * and none starts once `budgetMs` has passed (by `clock`): those not checked
 * stay due for the next run. Returns { excluded, back: [urls], still: [urls],
 * left } without writing.
 */
export async function planDeadRecheck({
  excluded,
  now = new Date(),
  render,
  answers = passesFullCheck({ render }),
  limit = DEAD_RECHECK_LIMIT,
  concurrency = DEAD_RECHECK_CONCURRENCY,
  budgetMs = DEAD_RECHECK_BUDGET_MS,
  clock = Date.now,
}) {
  const day = now.toISOString().slice(0, 10);
  const due = excluded
    .filter((e) => {
      const at = recheckDue(e);
      return at != null && at <= day;
    })
    .slice(0, limit);
  const started = clock();
  // An answer: true (back), false (still failing), or { ok: false, found } (it answers, but not as the same
  // site: still archived, with what was found recorded for the owner, passesFullCheck).
  const answered = await mapPool(due, concurrency, async (e) => await answers(e.url, e), { stop: () => clock() - started >= budgetMs });
  const back = new Set();
  const still = new Map();
  due.forEach((e, i) => {
    const a = answered[i];
    if (a === undefined) return;
    if (a === true || a?.ok === true) back.add(e);
    else still.set(e, a && typeof a === "object" && a.found ? a.found : null);
  });
  return {
    excluded: excluded
      .filter((e) => !back.has(e))
      .map((e) => {
        if (!still.has(e)) return e;
        const found = still.get(e);
        return { ...withoutFound(e), last_checked: day, recheck_after: nextArchiveCheck(e.removed, day), ...(found ? { found } : {}) };
      }),
    back: [...back].map((e) => e.url),
    backEntries: [...back],
    still: [...still.keys()].map((e) => e.url),
    left: due.length - back.size - still.size,
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
 * removed, entries `still` failing given their new check dates. With
 * `additions` (data/additions.json), each site back from the archive is also
 * recorded there as one our list keeps (build-feed.mjs LEFT_LIST, `left_on`
 * the day it came back), so it is listed again even when the community list
 * dropped it while it was archived; the feed build drops the record when the
 * community list has it.
 * plan: { added: [entry], back: [url], returning?: [{ url, name }], day?, still: [{ url, last_checked, recheck_after }] }.
 */
export function applyExport({ excluded, feed, additions }, plan) {
  const key = (u) => normKey(u);
  const back = new Set(plan.back.map(key));
  const still = new Map(plan.still.map((s) => [key(s.url), s]));
  const out = excluded
    .filter((e) => !back.has(key(excludedUrl(e))))
    .map((e) => {
      const s = typeof e === "object" ? still.get(key(e.url)) : null;
      if (!s) return e;
      return { ...withoutFound(e), last_checked: s.last_checked, recheck_after: s.recheck_after, ...(s.found ? { found: s.found } : {}) };
    });
  const have = new Set(out.map((e) => key(excludedUrl(e))));
  for (const a of plan.added) if (!have.has(key(a.url))) out.push(a);
  const drop = new Set(plan.added.map((a) => key(a.url)));
  const files = { excluded: out, feed: feed.filter((p) => !drop.has(key(p.url))) };
  if (!Array.isArray(additions)) return files;
  const names = new Map((plan.returning ?? []).map((r) => [key(r.url), r.name]));
  const known = new Set([...additions.map((a) => key(a?.url ?? "")), ...files.feed.map((p) => key(p.url))]);
  const recorded = [...additions];
  for (const url of plan.back) {
    if (known.has(key(url))) continue;
    known.add(key(url));
    recorded.push({ name: String(names.get(key(url)) ?? "").trim() || url, url, source: LEFT_LIST, left_on: plan.day ?? new Date().toISOString().slice(0, 10) });
  }
  return { ...files, additions: recorded };
}

/**
 * Whether main's data/excluded.json carries a planned export (its pull
 * request merged): no addition left to make (`added`: urls still to add,
 * already checked against today's state), the entries back are gone, the ones
 * still failing have their new dates.
 */
export function exportLanded({ excluded }, plan) {
  const have = new Map(excluded.map((e) => [normKey(excludedUrl(e)), e]));
  return !plan.added.length && plan.back.every((u) => !have.has(normKey(u))) && plan.still.every((s) => have.get(normKey(s.url))?.recheck_after === s.recheck_after);
}

/**
 * The weekly export, kept until it lands. `excluded` and `feed` are main's
 * files as checked out. Plans a new export when one is due (planExclusions,
 * then planDeadRecheck with the full check), keeps it in the cache table and
 * returns the files with every export not yet on main applied, or null when
 * there is nothing to apply.
 *
 * Additions are checked against the database every night: the plan keeps
 * only which sites it chose, and the entries are today's planExclusions, so a
 * site that recovered, or whose removal was undone, after the plan was made
 * drops out of it, and no site is ever exported that today's state would not
 * plan. An archived site that passes its check starts fresh: its old rows
 * move to a closed-off key (./archive-return.mjs retireArchivedSite), and once
 * the daily sync lists it again it is captured and ranked like a new site.
 * `dryRun` plans and returns the same and writes nothing.
 * Returns { files, plan: { added: [urls], back, still } | null, planned, landed, held }.
 */
export async function weeklyExport({ db, excluded, feed, additions, render, answers, now = new Date(), dryRun = false, log = () => {} }) {
  // Today's additions: the only entries ever applied.
  const today = await planExclusions({ db, excluded, feed, now, readOnly: dryRun });
  const todayAdds = new Map(today.added.map((a) => [normKey(a.url), a]));
  let pending = null;
  let landed = false;
  const row = await cacheGet(db, PENDING_EXPORT_KEY);
  if (row) {
    let stored = null;
    try {
      stored = JSON.parse(String(row.v));
    } catch {
      stored = null;
    }
    // The additions this plan chose that today's state still plans (and main does not carry yet).
    const current = stored
      ? { added: stored.added.filter((u) => todayAdds.has(normKey(u))), back: stored.back, still: stored.still, ...(stored.returning ? { returning: stored.returning } : {}), ...(stored.day ? { day: stored.day } : {}) }
      : null;
    if (current && exportLanded({ excluded }, current)) {
      landed = true;
      if (!dryRun) {
        await markExported(db, new Date(Number(row.at)));
        await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [PENDING_EXPORT_KEY] });
      }
    } else if (!current || now.getTime() - Number(row.at) >= PENDING_EXPORT_MAX_DAYS * 86400000) {
      log(`export: the export planned ${new Date(Number(row.at)).toISOString().slice(0, 10)} never landed; planning again`);
      if (!dryRun) await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [PENDING_EXPORT_KEY] });
    } else {
      pending = current;
      const dropped = stored.added.filter((u) => !current.added.includes(u) && !excluded.some((e) => normKey(excludedUrl(e)) === normKey(u)));
      if (dropped.length) log(`export: no longer down or decided, so not exported: ${dropped.join(", ")}`);
    }
  }
  let planned = false;
  if (!pending && (await exportDue(db, now))) {
    planned = true;
    const dead = await planDeadRecheck({ excluded, now, render, ...(answers ? { answers } : {}) });
    if (dead.left) log(`export: ${dead.left} removed site(s) due for their check were left for the next run (time budget)`);
    const stillSet = new Set(dead.still);
    const still = dead.excluded.filter((e) => typeof e === "object" && stillSet.has(e.url)).map((e) => ({ url: e.url, last_checked: e.last_checked, recheck_after: e.recheck_after, ...(e.found ? { found: e.found } : {}) }));
    const returning = dead.backEntries.map((e) => ({ url: e.url, name: e.name ?? null }));
    pending = { added: today.added.map((a) => a.url), back: dead.back, still, returning, day: now.toISOString().slice(0, 10) };
    const empty = !pending.added.length && !pending.back.length && !pending.still.length;
    if (!dryRun) {
      if (dead.back.length) {
        // A site back from the archive starts completely fresh (owner, 2026-11-23): the old site's rows move
        // to a closed-off key, so the returning site inherits no votes, rating, grade, claim or decision
        // (./archive-return.mjs). It is captured, measured and ranked from code like a new site.
        for (const url of dead.back) {
          const r = await retireArchivedSite(db, url, { now });
          const n = Object.values(r.moved).reduce((a, b) => a + b, 0);
          if (n) log(`export: ${url} is back from the archive and starts fresh; ${n} old row(s) moved to ${r.key}`);
        }
        // The owner's Health pool page lists what came back from the archive (./not-working.mjs health_returns).
        await db.batch(
          returnStatements(
            dead.backEntries.map((e) => ({ url: e.url, at: now.toISOString(), reason: e.reason ?? null, since: e.removed ?? null, hidden: true })),
            "archive",
            now
          ),
          "write"
        );
      }
      if (empty) await markExported(db, now);
      else await cacheSet(db, PENDING_EXPORT_KEY, JSON.stringify(pending), now.getTime());
    }
    if (empty) pending = null;
  }
  const entries = pending ? { ...pending, added: pending.added.map((u) => todayAdds.get(normKey(u))).filter(Boolean) } : null;
  return { files: entries ? applyExport({ excluded, feed, additions }, entries) : null, plan: pending, planned, landed, held: today.held };
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
              ${pooled ? `CASE WHEN ${VALID_MARKS()} THEN m.pool_since END` : "NULL"} AS pool_since,
              ${pooled ? `CASE WHEN ${VALID_MARKS()} THEN m.last_fail_at END` : "NULL"} AS last_fail_at
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
    // Every health failure (down or a duplicate) is in the temporary pool (./not-working.mjs): hidden, but on
    // the list until it has been so LEAVE_AFTER_DAYS AND a check made on or after that day has failed, so a
    // site never goes to the archive on a check weeks old. A row down with no ladder (from before the pool,
    // the old weekly-counted rule, or its marks voided) waits for its next nightly check, which puts it on
    // the ladder (in the pool since its first failure).
    if (kind !== "not_portfolio") {
      const since = r.pool_since == null ? null : String(r.pool_since);
      if (Number(r.pool_stage ?? 0) !== NOT_WORKING) {
        held.push({ url, why: "down with no ladder; its next check puts it in the temporary pool" });
        continue;
      }
      if (!leavesOnFreshFailure(since, r.last_fail_at == null ? null : String(r.last_fail_at))) {
        held.push({ url, why: `in the temporary pool since ${String(since).slice(0, 10)}; it is archived only when a check on or after day ${LEAVE_AFTER_DAYS} fails` });
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
