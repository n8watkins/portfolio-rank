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
// one person are never cached.
//
// Profiles and the blog are kept for a day and served stale for a week while one
// request refreshes them (docs/BOTS-AND-SEO.md: a crawler visits a long-tail page once in
// days, so a five-minute copy almost always missed and re-rendered for 300 to 400 ms of
// CPU). They are purged by tag when their data changes (CachedPages.purgeTags in
// worker/index.ts, lib/edge-purge.ts): a profile when its owner hides, shows or removes
// it, every profile after the end-of-day run, the blog when a post is published,
// unpublished or its scheduled time arrives. Their query string is dropped from the key,
// so ?utm_source= and random parameters can't force a render.
//
// The cache is shared across deploys (wrangler.jsonc cache.cross_version_cache) and
// keyed instead by a fingerprint of the build's static files
// (scripts/assets-fingerprint.mjs): a deploy that changes no CSS or JavaScript keeps
// every cached page, and one that does starts fresh, so a cached page never points at a
// stylesheet or script the live version no longer has.

import { siteKeyOf } from "../lib/grader/url.mjs";

/** Pages with ISR (`export const revalidate = 300`): the same five minutes at the edge. */
const PAGE_TTL_SECONDS = 300;

/** Pages and files that change only with a deploy or a new day's data. */
const SLOW_TTL_SECONDS = 3600;

/** The share image changes only with a deploy. */
const STATIC_TTL_SECONDS = 86_400;

/** After its time, the old copy is still served while one request refreshes it. */
const EDGE_STALE_SECONDS = 86_400;

/** Profiles and the blog: a day, purged by tag when their data changes, */
const LONG_TTL_SECONDS = 86_400;

/** and served stale for a week while one request refreshes them. */
const LONG_STALE_SECONDS = 7 * 86_400;

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
  "/twitter-image": STATIC_TTL_SECONDS,
};

/** Path patterns -> seconds: the leaderboard's views, and the sitemap index's parts (/sitemap/pages.xml, /sitemap/profiles-2.xml). */
const CACHEABLE_PATTERNS: [RegExp, number][] = [
  [/^\/top\/[^/]+$/, PAGE_TTL_SECONDS],
  [/^\/sitemap\/[a-z0-9-]+\.xml$/, SLOW_TTL_SECONDS],
];

/**
 * A profile and the blog's pages (not its media, which caches itself), each with its
 * generated share images: rendering one of those takes 3.6 to 4.7 s of CPU, so it is
 * made once per change and then served from the edge.
 *
 * A profile's address is either form while profiles move to readable addresses
 * (docs/BOTS-AND-SEO.md F1): the encoded one, /p/https%3A%2F%2Fjanedoe.dev, with its
 * images under it, or the readable one, /p/janedoe.dev or /p/jane.github.io/portfolio
 * (more than one segment), with its share image at /og/p/<the same>. Both carry the
 * same tag, so a purge reaches whichever is cached.
 */
const PROFILE = /^\/p\/(.+?)(?:\/(?:opengraph|twitter)-image)?$/;
const PROFILE_IMAGE = /^\/og\/p\/(.+)$/;
const BLOG = /^\/blog(?:\/rss\.xml|\/tag\/[^/]+|\/(?!media$|tag$)[^/]+(?:\/(?:opengraph|twitter)-image)?)?$/;

/** The tags every profile and every blog page carry, for the bulk purges. */
export const PROFILES_TAG = "profiles";
export const BLOG_TAG = "blog";

/** A profile page or its share image: the profile part of the path, or null. */
const profileSlug = (pathname: string) => (pathname.match(PROFILE) ?? pathname.match(PROFILE_IMAGE))?.[1] ?? null;

/** Profiles and the blog: long-lived, tagged, their query string left out of the key. */
const longLived = (pathname: string) => profileSlug(pathname) !== null || BLOG.test(pathname);

/** FNV-1a, so the Worker can tag a response without async crypto. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A profile's own tag, from its address: a hash of its site key (host without www,
 * path without the trailing slash, lower case; lib/grader/url.mjs siteKeyOf), the part
 * both forms of its page address share. A collision only purges one more page.
 */
export function profileTag(url: string): string {
  let key = url;
  try {
    key = siteKeyOf(url);
  } catch {}
  return `p:${fnv(key)}`;
}

/**
 * The address a profile path stands for: the encoded form decodes to it, the readable
 * one is the site key itself (its scheme doesn't change the tag). Throws on a slug that
 * doesn't decode.
 */
function addressOf(slug: string): string {
  const decoded = slug.split("/").map(decodeURIComponent).join("/");
  return /^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`;
}

/** The tags a response for this path carries (none for the short-lived pages). */
export function tagsFor(pathname: string): string[] {
  const slug = profileSlug(pathname);
  if (slug !== null) {
    try {
      return [PROFILES_TAG, profileTag(addressOf(slug))];
    } catch {
      return [PROFILES_TAG];
    }
  }
  return BLOG.test(pathname) ? [BLOG_TAG] : [];
}

/** PortfolioRank's own cookies: a visitor with any of them may see something of their own. */
const PERSONAL_COOKIE = /(?:^|;\s*)(?:__Secure-|__Host-)?(?:authjs\.|next-auth\.|pr_|pr-)/;

/** Seconds the edge may keep this path, or 0 when it is not on the list. */
export function ttlFor(pathname: string): number {
  if (pathname in CACHEABLE) return CACHEABLE[pathname];
  if (longLived(pathname)) return LONG_TTL_SECONDS;
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
 * The request CachedPages is called with, which is also the cache key: a profile's or
 * the blog's query string dropped, and the build's static-files fingerprint added
 * (`__a`), so pages cached for other CSS or JavaScript are never served.
 */
export function edgeRequest(request: Request, assets: string): Request {
  const url = new URL(request.url);
  if (longLived(url.pathname)) url.search = "";
  url.searchParams.set("__a", assets);
  return new Request(url, request);
}

/** The request the app sees inside CachedPages: the fingerprint taken out again. */
export function appRequest(request: Request): Request {
  const url = new URL(request.url);
  if (!url.searchParams.has("__a")) return request;
  url.searchParams.delete("__a");
  return new Request(url, request);
}

/**
 * The response marked for the edge: kept for its path's time when it is a 200 that sets
 * no cookie, otherwise never, and tagged for purging. Cloudflare reads
 * Cloudflare-CDN-Cache-Control and strips it, so browsers keep the Cache-Control
 * Next.js sent.
 */
export function forEdge(request: Request, response: Response): Response {
  const { pathname } = new URL(request.url);
  const ttl = ttlFor(pathname);
  const cacheable = ttl > 0 && response.status === 200 && !response.headers.has("set-cookie");
  const marked = new Response(response.body, response);
  const stale = longLived(pathname) ? LONG_STALE_SECONDS : EDGE_STALE_SECONDS;
  marked.headers.set("Cloudflare-CDN-Cache-Control", cacheable ? `public, max-age=${ttl}, stale-while-revalidate=${stale}` : "no-store");
  const tags = cacheable ? tagsFor(pathname) : [];
  if (tags.length) marked.headers.set("Cache-Tag", tags.join(","));
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
