import { getCloudflareContext } from "@opennextjs/cloudflare";
import { BLOG_TAG, PROFILES_TAG, profileTag } from "@/worker/edge-cache";

// Purging the edge cache from the app (worker/edge-cache.ts): profiles and the blog are
// kept for a day, so whatever changes what one of them shows purges its tag. The purge
// runs inside the CachedPages entrypoint (worker/index.ts purgeTags), the only one that
// can reach the entries it stored. Best effort and never throws: off the Workers (next
// dev, the tests) there is no cache, and a failed purge only means the page refreshes
// when its day is up.

type Exports = { exports?: { CachedPages?: { purgeTags(tags: string[]): Promise<boolean> } } };

export async function purgeEdge(tags: string[]): Promise<boolean> {
  if (!tags.length) return true;
  try {
    const { ctx } = await getCloudflareContext({ async: true });
    const cached = (ctx as unknown as Exports).exports?.CachedPages;
    if (!cached) return false;
    return await cached.purgeTags(tags);
  } catch (e) {
    console.log(JSON.stringify({ event: "edge.purge_failed", tags: tags.slice(0, 5), error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return false;
  }
}

/** A profile changed (an owner hid, showed or removed it). */
export const purgeProfile = (url: string) => purgeEdge([profileTag(url)]);

/** Every profile (the end-of-day run moved ranks and grades). */
export const purgeProfiles = () => purgeEdge([PROFILES_TAG]);

/** The blog's pages (a post was published or unpublished, or its time came). */
export const purgeBlog = () => purgeEdge([BLOG_TAG]);
