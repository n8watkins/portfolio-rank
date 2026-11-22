import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { GONE_WHERE, HIDDEN_WHERE } from "@/lib/hidden.mjs";
import { ownerMarks, ownerSiteKey } from "@/lib/ownership/same-site.mjs";

const known = new Set((feed as { url: string }[]).map((p) => p.url));

// Listed addresses by owner site key, so a removal asked for under one
// spelling hides the listed one too (lib/ownership/same-site.mjs).
const listedByOwnerKey = new Map<string, string[]>();
for (const url of known) {
  const key = ownerSiteKey(url);
  listedByOwnerKey.set(key, [...(listedByOwnerKey.get(key) ?? []), url]);
}

/**
 * Every spelling of the sites whose verified owner removed them (lib/games/claims.mjs ownerAction):
 * the addresses the removals were asked under and every listed address of the same site.
 */
async function ownerRemovedUrls(): Promise<string[]> {
  const marks = await ownerMarks(db());
  return [...marks.removedUrls, ...[...marks.removed].flatMap((key) => listedByOwnerKey.get(key) ?? [])];
}

/** True if the URL is an actual portfolio from the list. */
export function isKnownPortfolio(url: string): boolean {
  return known.has(url);
}

// The set changes when the health check (nightly, and hourly for the not-working pool) or a capture runs, so each
// isolate keeps it for a few minutes instead of scanning portfolios on every
// page render and vote (docs/COSTS.md section C).
const HIDDEN_TTL_MS = 5 * 60 * 1000;
let hiddenCache: { at: number; urls: Promise<Set<string>> } | null = null;

/**
 * Roster URLs the site should not show (browse, matchups, leaderboards):
 * - not working or confirmed down by the health check (pipeline/not-working.mjs,
 *   pipeline/health.mjs); back as they were when the site works again;
 * - a failed capture (dead/parked/error) the health check hasn't cleared yet.
 *   Captures are retried with backoff, and a passing health check shows the
 *   site again, so one transient error no longer hides a site for good.
 * "Suspect" sites stay visible: one failed check proves nothing (they are out of the AI's work only).
 * - removed by their verified owner (lib/games/claims.mjs), under any
 *   spelling of the site (lib/ownership/same-site.mjs), until the weekly
 *   exclusions pull request takes them off the list for good.
 * The rule itself is lib/hidden.mjs, shared with the ranking recompute.
 */
export async function hiddenUrls(): Promise<Set<string>> {
  const now = Date.now();
  if (hiddenCache && now - hiddenCache.at < HIDDEN_TTL_MS) return hiddenCache.urls;
  const urls = (async () => {
    await ensureSchema();
    const [res, removed] = await Promise.all([db().execute(`SELECT url FROM portfolios WHERE ${HIDDEN_WHERE}`), ownerRemovedUrls()]);
    return new Set([...res.rows.map((r) => String(r.url)), ...removed]);
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
 * Whether one site is hidden right now (the same rule as hiddenUrls), for
 * checks about a single site: a primary-key lookup, never cached, plus the
 * owners' marked rows (cached a minute per isolate, lib/ownership/same-site.mjs).
 */
export async function isHidden(url: string): Promise<boolean> {
  await ensureSchema();
  const [res, marks] = await Promise.all([db().execute({ sql: `SELECT 1 FROM portfolios WHERE url = ? AND (${HIDDEN_WHERE})`, args: [url] }), ownerMarks(db())]);
  return res.rows.length > 0 || marks.isRemoved(url);
}

/**
 * Whether a listed site has no profile right now: not working, or confirmed
 * down (lib/hidden.mjs GONE_WHERE). Its page answers not found until the site
 * works again. A primary-key lookup, never cached.
 */
export async function isGone(url: string): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({ sql: `SELECT 1 FROM portfolios WHERE url = ? AND ${GONE_WHERE}`, args: [url] });
  return res.rows.length > 0;
}
