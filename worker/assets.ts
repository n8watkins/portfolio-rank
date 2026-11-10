// Image requests the Worker answers itself, before the Next.js app, from the
// edge cache (caches.default) when it can:
//
// - /shots/<shot_key>/<file>?v=<version>: our screenshots from the SHOTS R2
//   bucket. Pages add ?v= (the capture's time, lib/shot-url.ts), so a
//   recapture gets a new URL and the old one can be cached forever. Without a
//   version the response is cached for a day.
// - /favicon/<domain>: a roster site's icon, fetched from Google's favicon
//   service, or a neutral placeholder when it has none (instead of a 404 and
//   a console error per missing icon). Only roster domains are served.
import feed from "../data/feed.json";

const SHOT_FILES = new Set(["hero.jpg", "mobile.jpg", "full.jpg"]);
const YEAR = 31536000;
const WEEK = 604800;

const rosterDomains = new Set(
  (feed as { url: string }[]).flatMap((p) => {
    try {
      return [new URL(p.url).hostname.replace(/^www\./, "")];
    } catch {
      return [];
    }
  })
);

// A rounded square in the site's edge colour: the same footprint as a real icon.
const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#26262b"/><circle cx="32" cy="32" r="12" fill="none" stroke="#8b8b93" stroke-width="3"/><path d="M20 32h24M32 20c-4 4-4 20 0 24M32 20c4 4 4 20 0 24" fill="none" stroke="#8b8b93" stroke-width="2"/></svg>`;

type Env = Pick<CloudflareEnv, "SHOTS">;
type Ctx = { waitUntil(promise: Promise<unknown>): void };

async function shot(key: string, file: string, versioned: boolean, env: Env): Promise<Response> {
  const object = await env.SHOTS.get(`${key}/${file}`);
  if (!object) return new Response("not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": versioned ? `public, max-age=${YEAR}, immutable` : "public, max-age=86400",
      ETag: object.httpEtag,
    },
  });
}

async function favicon(domain: string): Promise<Response> {
  const headers = { "Cache-Control": `public, max-age=${WEEK}` };
  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, {
      signal: AbortSignal.timeout(5000),
    });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.startsWith("image/")) {
      return new Response(res.body, { headers: { ...headers, "Content-Type": type } });
    }
  } catch {
    /* fall through to the placeholder */
  }
  return new Response(PLACEHOLDER, { headers: { ...headers, "Content-Type": "image/svg+xml" } });
}

/**
 * How to answer an image route (uncached), or null when the URL isn't one.
 * The Next.js routes app/shots and app/favicon use it too, for `next dev`.
 */
export function imageFor(url: URL, env: Env): (() => Promise<Response>) | null {
  const s = url.pathname.match(/^\/shots\/([0-9a-f]{16})\/([a-z]+\.jpg)$/);
  if (s && SHOT_FILES.has(s[2])) {
    const versioned = /^[0-9a-z]{1,16}$/.test(url.searchParams.get("v") ?? "");
    return () => shot(s[1], s[2], versioned, env);
  }
  const f = url.pathname.match(/^\/favicon\/([a-z0-9.-]{1,253})$/);
  if (f) {
    if (!rosterDomains.has(f[1])) return async () => new Response("not found", { status: 404 });
    return () => favicon(f[1]);
  }
  return null;
}

/** The response for an image route, or null to let the app handle the request. */
export async function serveImage(request: Request, env: Env, ctx: Ctx): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const make = imageFor(url, env);
  if (!make) return null;

  // Cache by the canonical URL only (no cookies, no stray query keys).
  const v = url.searchParams.get("v");
  const cacheKey = new Request(`${url.origin}${url.pathname}${v ? `?v=${encodeURIComponent(v)}` : ""}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = await make();
  if (res.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
