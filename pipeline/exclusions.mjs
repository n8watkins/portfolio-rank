// Our list wins: sites the health check confirmed down go into
// data/excluded.json with the reason and the evidence, and out of
// data/feed.json, so generate_feed.py keeps them out even while the community
// list still has them. The weekly health workflow commits both files through
// the same bot pull request flow as the daily upstream sync.
//
// data/excluded.json holds objects:
//   { url, name, reason, kind, removed, first_failed?, last_checked?, checks?,
//     decided_by?, evidence?, duplicate_of?, recheck_after? }
// kind: "down" (failed to load, parked, hijacked or blank), "dead" (the name
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
import { normKey } from "./health.mjs";

// Refuse to exclude more than this share of the list in one go.
export const MAX_EXCLUDE_SHARE = 0.1;

export function kindOf(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("duplicate of")) return "duplicate";
  if (r.startsWith("AI grading says")) return "not_portfolio";
  return "down";
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

/**
 * Whether a site answers now (the dead-entry re-check): the name resolves and
 * the page loads with a 2xx answer that isn't an error page. One plain
 * request; never throws.
 */
export async function siteAnswers(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Mozilla/5.0 PortfolioRank-health" } });
    if (!res.ok) return false;
    const text = (await res.text()).slice(0, 200000);
    return text.length > 200 && !/site not found|there isn.t a github pages site here|deployment not found|404: not found|page not found/i.test(text);
  } catch {
    return false;
  }
}

/**
 * The dead entries due for their check (recheck_after on or before today),
 * at most `limit`: one that answers now leaves the list (it returns with the
 * next sync if the community list still has it); one that doesn't gets its
 * next check DEAD_RECHECK_DAYS later. Returns { excluded, back: [urls],
 * still: [urls] } without writing.
 */
export async function planDeadRecheck({ excluded, now = new Date(), answers = siteAnswers, limit = DEAD_RECHECK_LIMIT }) {
  const day = now.toISOString().slice(0, 10);
  const next = new Date(now.getTime() + DEAD_RECHECK_DAYS * 86400000).toISOString().slice(0, 10);
  const due = excluded.filter((e) => e && typeof e === "object" && e.kind === "dead" && String(e.recheck_after ?? "") <= day).slice(0, limit);
  const back = new Set();
  const still = new Set();
  for (const e of due) {
    if (await answers(e.url)) back.add(e);
    else still.add(e);
  }
  return {
    excluded: excluded.filter((e) => !back.has(e)).map((e) => (still.has(e) ? { ...e, last_checked: day, recheck_after: next } : e)),
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
      `SELECT url, name, health_reason, health_fails, health_first_fail_at, health_checked_at
       FROM portfolios WHERE health = 'down' AND delisted_at IS NULL ORDER BY url`
    )
  ).rows;
  const onFeed = new Map(feed.map((p) => [p.url, p]));
  const day = now.toISOString().slice(0, 10);
  const added = [];
  for (const r of rows) {
    const url = String(r.url);
    if (!onFeed.has(url) || have.has(normKey(url))) continue;
    added.push({
      url,
      name: onFeed.get(url).name ?? (r.name == null ? url : String(r.name)),
      reason: String(r.health_reason ?? ""),
      kind: kindOf(r.health_reason),
      removed: day,
      first_failed: r.health_first_fail_at == null ? null : String(r.health_first_fail_at),
      last_checked: r.health_checked_at == null ? null : String(r.health_checked_at),
      checks: Number(r.health_fails ?? 0),
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
    excluded: [...excluded, ...added],
    feed: feed.filter((p) => !drop.has(normKey(p.url))),
  };
}
