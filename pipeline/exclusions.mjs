// Our list wins: sites the health check confirmed down go into
// data/excluded.json with the reason and the evidence, and out of
// data/feed.json, so generate_feed.py keeps them out even while the community
// list still has them. The weekly health workflow commits both files through
// the same bot pull request flow as the daily upstream sync.
//
// data/excluded.json holds objects:
//   { url, name, reason, kind, removed, first_failed?, last_checked?, checks? }
// kind: "down" (failed to load, parked, hijacked or blank), "duplicate",
// "not_portfolio" (graded so by the AI and confirmed the same way) or
// "owner_request" (a takedown). Plain URL strings (the old format) still work.

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
