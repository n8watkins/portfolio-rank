// The Worker's own edge cache (Workers Cache, https://developers.cloudflare.com/workers/cache/).
//
// The default entrypoint (worker/index.ts) runs on every request and is cheap: it
// decides here whether a request may be answered from the cache, and if so passes it to
// the CachedPages entrypoint, which Cloudflare's cache sits in front of (wrangler.jsonc
// "cache" and "exports"). A hit returns the stored response without running Next.js, so
// it costs no CPU time; a miss renders once and is kept for the next visitor.
//
// Only a short list of public paths may be cached, and only for a visitor who carries
// none of PortfolioRank's own cookies: no Auth.js session, no practice voter (pr_anon),
// no owned grade reports (pr_grades), no face-off intro flag. Those visitors may see
// something of their own, so they always reach Next.js. A response is kept only if it is
// a 200 that sets no cookie. POSTs, the API, grade reports, the admin and every page for
// one person are never cached. Each deploy starts with an empty cache (the Worker
// version is part of the key).

/** Pages with ISR (`export const revalidate = 300`): the same five minutes at the edge. */
const PAGE_TTL_SECONDS = 300;

/** Pages and files that change only with a deploy or a new day's data. */
const SLOW_TTL_SECONDS = 3600;

/** The share image changes only with a deploy. */
const STATIC_TTL_SECONDS = 86_400;

/** After its time, the old copy is still served while one request refreshes it. */
const EDGE_STALE_SECONDS = 86_400;

/** Exact paths -> seconds. */
const CACHEABLE: Record<string, number> = {
  "/": PAGE_TTL_SECONDS,
  "/top": PAGE_TTL_SECONDS,
  "/browse": PAGE_TTL_SECONDS,
  "/play": PAGE_TTL_SECONDS,
  "/polls": PAGE_TTL_SECONDS,
  "/how": SLOW_TTL_SECONDS,
  "/grading": SLOW_TTL_SECONDS,
  "/sitemap.xml": SLOW_TTL_SECONDS,
  "/robots.txt": SLOW_TTL_SECONDS,
  "/opengraph-image": STATIC_TTL_SECONDS,
};

/** Path patterns -> seconds: the leaderboard's views and the portfolio pages. */
const CACHEABLE_PATTERNS: [RegExp, number][] = [
  [/^\/top\/[^/]+$/, PAGE_TTL_SECONDS],
  [/^\/p\/[^/]+$/, PAGE_TTL_SECONDS],
];

/** PortfolioRank's own cookies: a visitor with any of them may see something of their own. */
const PERSONAL_COOKIE = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:authjs\.|next-auth\.|pr_|pr-)/;

/** Seconds the edge may keep this path, or 0 when it is not on the list. */
export function ttlFor(pathname: string): number {
  if (pathname in CACHEABLE) return CACHEABLE[pathname];
  for (const [pattern, ttl] of CACHEABLE_PATTERNS) if (pattern.test(pathname)) return ttl;
  return 0;
}

/** Whether this request may be answered from the edge cache. */
export function mayUseEdgeCache(request: Request, host: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  // The cache key has no host in it, so only the site's own address reads or writes it.
  if (url.hostname !== host) return false;
  if (!ttlFor(url.pathname)) return false;
  if (request.headers.has("authorization")) return false;
  // Client-side navigations ask for the page's RSC payload, not its HTML.
  if (request.headers.has("rsc") || request.headers.has("next-router-prefetch") || url.searchParams.has("_rsc")) {
    return false;
  }
  if (PERSONAL_COOKIE.test(request.headers.get("cookie") ?? "")) return false;
  return true;
}

/**
 * The response marked for the edge: kept for its path's time when it is a 200 that sets
 * no cookie, otherwise never. Cloudflare reads Cloudflare-CDN-Cache-Control and strips
 * it, so browsers keep the Cache-Control Next.js sent.
 */
export function forEdge(request: Request, response: Response): Response {
  const ttl = ttlFor(new URL(request.url).pathname);
  const cacheable = ttl > 0 && response.status === 200 && !response.headers.has("set-cookie");
  const marked = new Response(response.body, response);
  marked.headers.set(
    "Cloudflare-CDN-Cache-Control",
    cacheable ? `public, max-age=${ttl}, stale-while-revalidate=${EDGE_STALE_SECONDS}` : "no-store",
  );
  return marked;
}

/** Scanners probing for /.env, /.git/config, /.claude/settings.json, /wp-admin and *.php. */
const PROBE = /^\/(?:\.(?!well-known\/)|wp-|.*\.php$)/i;

/** A plain 404 for scanner probes, answered before Next.js, or null for everything else. */
export function probeAnswer(request: Request): Response | null {
  if (!PROBE.test(new URL(request.url).pathname)) return null;
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
