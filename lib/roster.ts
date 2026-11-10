import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";

const known = new Set((feed as { url: string }[]).map((p) => p.url));

/** True if the URL is an actual portfolio from the list. */
export function isKnownPortfolio(url: string): boolean {
  return known.has(url);
}

/**
 * Roster URLs the site should not show (browse, matchups, leaderboards):
 * - confirmed down by the weekly health check (pipeline/health.mjs), on their
 *   way into data/excluded.json;
 * - a failed capture (dead/parked/error) the health check hasn't cleared yet.
 *   Captures are retried with backoff, and a passing health check shows the
 *   site again, so one transient error no longer hides a site for good.
 * "Suspect" sites stay visible: one failed check proves nothing.
 */
export async function hiddenUrls(): Promise<Set<string>> {
  await ensureSchema();
  const res = await db().execute(
    `SELECT url FROM portfolios
     WHERE health = 'down'
        OR (status IN ('dead', 'parked', 'error') AND COALESCE(health, '') != 'live')`
  );
  return new Set(res.rows.map((r) => String(r.url)));
}
