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
    // The zone's Browser Cache TTL raises a cached copy's max-age (to 4 hours
    // on this zone); give the browser the max-age the route chose instead.
    // A copy older than the route's max-age counts as a miss, whatever TTL the
    // zone gave the stored copy.
    if (hit && !expired(hit)) return withHeader(hit, "cache-control", originalCacheControl(hit));
  } catch {
    /* a cache failure only costs a fresh answer */
  }
  const res = await make();
  if (res.status === 200) {
    const copy = res.clone();
    // Keep the route's own cache-control beside the one the zone may rewrite.
    const stored = withHeader(copy, ORIGINAL, copy.headers.get("cache-control") ?? "");
    runInBackground(cache.put(request, stored));
  }
  return res;
}

const ORIGINAL = "x-origin-cache-control";

function originalCacheControl(hit: Response): string {
  return hit.headers.get(ORIGINAL) || hit.headers.get("cache-control") || "no-cache";
}

function expired(hit: Response): boolean {
  const maxAge = Number(originalCacheControl(hit).match(/max-age=(\d+)/)?.[1] ?? 0);
  return Number(hit.headers.get("age") ?? 0) >= maxAge;
}

function withHeader(res: Response, name: string, value: string): Response {
  const out = new Response(res.body, res);
  out.headers.set(name, value);
  if (name === "cache-control") out.headers.delete(ORIGINAL);
  return out;
}
