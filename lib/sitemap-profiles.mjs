// Which portfolio profiles (/p/<address>) the sitemap lists (app/sitemap.ts):
// only sites on the list that the site shows (not hidden by the health
// check) and that have an AI grade that says they are a portfolio. An
// ungraded or "not a portfolio" profile is thin, so search engines are never
// sent to one, whatever the launch switches say.

/** Portfolios with a usable AI grade that isn't "not a portfolio", as one query. */
export const GRADED_SQL = `SELECT url FROM portfolios
  WHERE json_valid(ai_rubric) AND json_extract(ai_rubric, '$.tier') IS NOT NULL
    AND json_extract(ai_rubric, '$.error') IS NULL
    AND COALESCE(json_extract(ai_rubric, '$.is_portfolio'), 1) != 0`;

/**
 * @param {{ execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }} db
 * @returns {Promise<Set<string>>}
 */
export async function gradedUrls(db) {
  const r = await db.execute(GRADED_SQL);
  return new Set(r.rows.map((x) => String(x.url)));
}

/**
 * The listed addresses whose profile belongs in the sitemap, in list order.
 * @param {{ url: string }[]} feed the list (data/feed.json)
 * @param {Set<string>} hidden sites the site doesn't show (lib/roster.ts hiddenUrls)
 * @param {Set<string>} graded gradedUrls()
 * @returns {string[]}
 */
export function sitemapProfiles(feed, hidden, graded) {
  return feed.map((p) => p.url).filter((url) => !hidden.has(url) && graded.has(url));
}
