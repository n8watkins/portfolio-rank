// Our list wins: sites the health check confirmed down go into
// data/excluded.json with the reason and the evidence, and out of
// data/feed.json, so generate_feed.py keeps them out even while the community
// list still has them. The weekly health workflow commits both files through
// the same bot pull request flow as the daily upstream sync.
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
export const removedForNotAnswering = (reason) => /^(HTTP \d|does not load|DNS|connect timeout|TLS|timeout|connection dropped)/.test(String(reason ?? ""));

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

/**
 * Add confirmed-down listed rows to the exclusion list and drop them from the
 * feed. Returns { added: [...entries], excluded, feed } without writing; the
 * caller writes the files.
 */
export async function planExclusions({ db, excluded, feed, now = new Date() }) {
  const have = new Set(excluded.map((e) => normKey(excludedUrl(e))));
  const rows = (
    await db.execute(
      `SELECT url, name, status, reason, health_reason, health_fails, health_first_fail_at, health_checked_at
       FROM portfolios WHERE health = 'down' AND delisted_at IS NULL ORDER BY url`
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
