// Purging the profiles whose tier letter changed (./tiers.ts, the daily run):
// profiles stay in the edge cache for a day (./edge-cache.ts), so each changed
// profile is purged by its tag (./edge-cache.ts profileTag, passed in). Kept
// apart from ./tiers.ts, with no imports, so it can be tested on its own.

/** CachedPages.purgeTags (worker/index.ts): purges at most 100 tags a call. */
export type PurgeTags = (tags: string[]) => Promise<boolean>;
export const PURGE_BATCH = 100;

/**
 * Purges the profiles of `urls` by tag (`tagOf`: profileTag), 100 at a time, and
 * returns how many tags were purged. Best effort: a failed batch is logged and
 * only means those pages refresh when their day is up.
 */
export async function purgeProfilesOf(urls: string[], purgeTags: PurgeTags | undefined, tagOf: (url: string) => string): Promise<number> {
  if (!purgeTags || !urls.length) return 0;
  const tags = [...new Set(urls.map(tagOf))];
  let sent = 0;
  for (let i = 0; i < tags.length; i += PURGE_BATCH) {
    const part = tags.slice(i, i + PURGE_BATCH);
    try {
      if (await purgeTags(part)) sent += part.length;
    } catch (e) {
      console.log(JSON.stringify({ event: "tiers.purge_failed", error: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
  }
  return sent;
}
