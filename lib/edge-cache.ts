import { runInBackground } from "./background";

// The Cache API of the Cloudflare data center that serves the request
// (caches.default). A Worker's responses are not cached by Cloudflare on
// their own, so a public, slow-moving JSON answer is kept here for its
// max-age: one database read per data center per max-age instead of one per
// request (docs/COSTS.md section C). Outside Workers (next dev, next start in
// the end-to-end tests) there is no caches.default and every request is made
// fresh.

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function edgeCache(): EdgeCache | null {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
}

/**
 * The cached response for `key` (a canonical absolute URL: only the inputs
 * that change the answer), or `make()`'s, which is stored when it is a 200.
 * `make` must set a cache-control max-age; the cache honours it.
 */
export async function cachedResponse(key: string, make: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  if (!cache) return make();
  const request = new Request(key);
  try {
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
    /* a cache failure only costs a fresh answer */
  }
  const res = await make();
  if (res.status === 200) runInBackground(cache.put(request, res.clone()));
  return res;
}
