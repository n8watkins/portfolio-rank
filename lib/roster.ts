import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { HIDDEN_WHERE } from "@/lib/hidden.mjs";

// A site its verified owner removed (lib/games/claims.mjs ownerAction).
const OWNER_REMOVED = "removed_at IS NOT NULL";

const known = new Set((feed as { url: string }[]).map((p) => p.url));

/** True if the URL is an actual portfolio from the list. */
export function isKnownPortfolio(url: string): boolean {
  return known.has(url);
}

// The set changes when the weekly health check or a capture runs, so each
// isolate keeps it for a few minutes instead of scanning portfolios on every
// page render and vote (docs/COSTS.md section C).
const HIDDEN_TTL_MS = 5 * 60 * 1000;
let hiddenCache: { at: number; urls: Promise<Set<string>> } | null = null;

/**
 * Roster URLs the site should not show (browse, matchups, leaderboards):
 * - confirmed down by the weekly health check (pipeline/health.mjs), on their
 *   way into data/excluded.json;
 * - a failed capture (dead/parked/error) the health check hasn't cleared yet.
 *   Captures are retried with backoff, and a passing health check shows the
 *   site again, so one transient error no longer hides a site for good.
 * "Suspect" sites stay visible: one failed check proves nothing.
 * - removed by their verified owner (lib/games/claims.mjs), until the
 *   weekly exclusions pull request takes them off the list for good.
 * The rule itself is lib/hidden.mjs, shared with the ranking recompute.
 */
export async function hiddenUrls(): Promise<Set<string>> {
  const now = Date.now();
  if (hiddenCache && now - hiddenCache.at < HIDDEN_TTL_MS) return hiddenCache.urls;
  const urls = (async () => {
    await ensureSchema();
    const res = await db().execute(
      `SELECT url FROM portfolios WHERE ${HIDDEN_WHERE} UNION SELECT url FROM portfolio_owner WHERE ${OWNER_REMOVED}`
    );
    return new Set(res.rows.map((r) => String(r.url)));
  })();
  const entry = { at: now, urls };
  hiddenCache = entry;
  // A failed read is not kept: the next call asks again.
  urls.catch(() => {
    if (hiddenCache === entry) hiddenCache = null;
  });
  return urls;
}

/**
 * Whether one site is hidden right now (the same rule as hiddenUrls): a
 * primary-key lookup, never cached, for checks about a single site.
 */
export async function isHidden(url: string): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT 1 FROM portfolios WHERE url = ?1 AND (${HIDDEN_WHERE}) UNION ALL SELECT 1 FROM portfolio_owner WHERE url = ?1 AND ${OWNER_REMOVED}`,
    args: [url],
  });
  return res.rows.length > 0;
}
