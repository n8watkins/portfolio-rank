// Which portfolio profiles (/p/<address>) the sitemap lists (app/sitemap.xml,
// app/sitemap/[part], lib/sitemaps.mjs): only sites on the list that the
// site shows (not hidden by the health check) and that are real profiles by
// lib/tiers-store.mjs IN_LIBRARY_SQL: a ranked library member by code with a
// good capture, or a Gemini "yes"; never a Gemini "not a portfolio" on
// record. Search engines are never sent to a thin profile, whatever the launch
// switches say; the page itself says noindex (app/p/[...slug]).
import { latest } from "./sitemaps.mjs";
import { IN_LIBRARY_SQL, addressNotPortfolio, hasTierTable } from "./tiers-store.mjs";

/**
 * The profiles the sitemap may list, as one query, with what a profile shows
 * changing: when it was graded, when its screenshot was taken and when its
 * rating last moved. `tiers` false: the tier table does not exist yet.
 */
export const profilesSql = ({ tiers = true } = {}) => `SELECT p.url, p.final_url,
    CASE WHEN json_valid(p.ai_rubric) THEN json_extract(p.ai_rubric, '$.judged_at') END AS judged_at, p.captured_at, r.updated_at AS rated_at
  FROM portfolios p LEFT JOIN ratings r ON r.url = p.url
  WHERE ${IN_LIBRARY_SQL("p", { tiers })}`;

/**
 * The sitemap's profiles (IN_LIBRARY_SQL) and when each last changed (the latest of its
 * grade, its screenshot and its rating; null when none is known).
 * @param {{ execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @returns {Promise<Map<string, string | null>>}
 */
export async function gradedProfiles(db) {
  const r = await db.execute(profilesSql({ tiers: await hasTierTable(db) }));
  return new Map(r.rows.filter((x) => !addressNotPortfolio(x)).map((x) => [String(x.url), latest(x.judged_at, x.captured_at, x.rated_at)]));
}

/**
 * @param {{ execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @returns {Promise<Set<string>>}
 */
export async function gradedUrls(db) {
  return new Set((await gradedProfiles(db)).keys());
}

/**
 * The listed addresses whose profile belongs in the sitemap, in list order.
 * @param {{ url: string }[]} feed the list (data/feed.json)
 * @param {Set<string>} hidden sites the site doesn't show (lib/roster.ts hiddenUrls)
 * @param {{ has(url: string): boolean }} graded gradedUrls() or gradedProfiles()
 * @returns {string[]}
 */
export function sitemapProfiles(feed, hidden, graded) {
  return feed.map((p) => p.url).filter((url) => !hidden.has(url) && graded.has(url));
}
