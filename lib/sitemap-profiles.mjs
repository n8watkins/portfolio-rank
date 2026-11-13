// Which portfolio profiles (/p/<address>) the sitemap lists (app/sitemap.xml,
// app/sitemap/[part], lib/sitemaps.mjs): only sites on the list that the
// site shows (not hidden by the health check) and that have an AI grade that
// says they are a portfolio. An ungraded or "not a portfolio" profile is
// thin, so search engines are never sent to one, whatever the launch
// switches say; the page itself says noindex (app/p/[...slug]).
import { latest } from "./sitemaps.mjs";

/**
 * Portfolios with a usable AI grade that isn't "not a portfolio", as one
 * query, with what a profile shows changing: when it was graded, when its
 * screenshot was taken and when its rating last moved.
 */
export const GRADED_SQL = `SELECT p.url, json_extract(p.ai_rubric, '$.judged_at') AS judged_at, p.captured_at, r.updated_at AS rated_at
  FROM portfolios p LEFT JOIN ratings r ON r.url = p.url
  WHERE json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.tier') IS NOT NULL
    AND json_extract(p.ai_rubric, '$.error') IS NULL
    AND COALESCE(json_extract(p.ai_rubric, '$.is_portfolio'), 1) != 0`;

/**
 * Graded portfolios and when each profile last changed (the latest of its
 * grade, its screenshot and its rating; null when none is known).
 * @param {{ execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @returns {Promise<Map<string, string | null>>}
 */
export async function gradedProfiles(db) {
  const r = await db.execute(GRADED_SQL);
  return new Map(r.rows.map((x) => [String(x.url), latest(x.judged_at, x.captured_at, x.rated_at)]));
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
