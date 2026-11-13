// The edge cache's rules (worker/edge-cache.ts), offline: which requests may be
// answered from Workers Cache, and which responses may be kept there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appRequest, edgeRequest, forEdge, mayUseEdgeCache, probeAnswer, profileTag, tagsFor, ttlFor } from "../worker/edge-cache.ts";

const HOST = "portfoliorank.n8builds.dev";
const BASE = `https://${HOST}`;

const get = (path, headers = {}) => new Request(`${BASE}${path}`, { headers });

test("public pages, sitemap, robots.txt and the share image may be cached", () => {
  for (const path of ["/", "/top", "/top/new", "/browse", "/play", "/play?mode=guess", "/polls", "/how", "/grading", "/p/https%3A%2F%2Fexample.com", "/sitemap.xml", "/robots.txt", "/opengraph-image"]) {
    assert.equal(mayUseEdgeCache(get(path), HOST), true, path);
  }
});

test("the API, grade reports, personal pages and the admin never are", () => {
  for (const path of ["/api/polls", "/api/polls/mine", "/api/leaderboard", "/grade", "/grade/abc", "/me", "/profile", "/settings", "/votes", "/claim", "/admin/images", "/report/print", "/p/a/b"]) {
    assert.equal(mayUseEdgeCache(get(path), HOST), false, path);
  }
});

test("a visitor with any of PortfolioRank's cookies always reaches the app", () => {
  for (const cookie of [
    "authjs.session-token=x",
    "__Secure-authjs.session-token=x",
    "theme=dark; pr_anon=abc.sig",
    "pr_grades=xyz",
    "pr-faceoff-intro=1",
  ]) {
    assert.equal(mayUseEdgeCache(get("/", { cookie }), HOST), false, cookie);
  }
  assert.equal(mayUseEdgeCache(get("/", { cookie: "cf_clearance=1" }), HOST), true);
});

test("only GET and HEAD on the site's own host, without auth or RSC headers", () => {
  assert.equal(mayUseEdgeCache(new Request(`${BASE}/`, { method: "POST" }), HOST), false);
  assert.equal(mayUseEdgeCache(new Request(`${BASE}/`, { method: "HEAD" }), HOST), true);
  assert.equal(mayUseEdgeCache(new Request("https://staging.portfoliorank.n8builds.dev/"), HOST), false);
  assert.equal(mayUseEdgeCache(get("/", { authorization: "Bearer x" }), HOST), false);
  assert.equal(mayUseEdgeCache(get("/", { rsc: "1" }), HOST), false);
  assert.equal(mayUseEdgeCache(get("/", { "next-router-prefetch": "1" }), HOST), false);
  assert.equal(mayUseEdgeCache(get("/?_rsc=abc"), HOST), false);
});

test("a 200 without cookies is kept for its path's time; anything else is not", () => {
  const ok = forEdge(get("/"), new Response("x", { headers: { "Cache-Control": "s-maxage=300" } }));
  assert.equal(ok.headers.get("Cloudflare-CDN-Cache-Control"), "public, max-age=300, stale-while-revalidate=86400");
  assert.equal(ok.headers.get("Cache-Control"), "s-maxage=300");

  assert.equal(ttlFor("/how"), 3600);
  assert.equal(ttlFor("/opengraph-image"), 86400);

  const cookie = forEdge(get("/"), new Response("x", { headers: { "Set-Cookie": "pr_anon=1" } }));
  assert.equal(cookie.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
  const missing = forEdge(get("/p/x"), new Response("x", { status: 404 }));
  assert.equal(missing.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
  const error = forEdge(get("/"), new Response("x", { status: 500 }));
  assert.equal(error.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
});

test("scanner probes get a plain 404; real paths and .well-known are left alone", () => {
  for (const path of ["/.env", "/.git/config", "/.claude/settings.json", "/wp-login.php", "/x/info.php"]) {
    const response = probeAnswer(get(path));
    assert.equal(response?.status, 404, path);
    assert.equal(response?.headers.get("Cache-Control"), "no-store");
  }
  for (const path of ["/", "/top", "/.well-known/security.txt", "/healthz", "/p/x"]) {
    assert.equal(probeAnswer(get(path)), null, path);
  }
});

test("profiles and the blog are kept a day, stale for a week, and tagged for purging", () => {
  const url = "https://example.com";
  const profile = forEdge(get(`/p/${encodeURIComponent(url)}`), new Response("x"));
  assert.equal(profile.headers.get("Cloudflare-CDN-Cache-Control"), "public, max-age=86400, stale-while-revalidate=604800");
  assert.equal(profile.headers.get("Cache-Tag"), `profiles,${profileTag(url)}`);
  for (const path of ["/blog", "/blog/a-post", "/blog/tag/react", "/blog/rss.xml"]) {
    assert.equal(mayUseEdgeCache(get(path), HOST), true, path);
    assert.equal(ttlFor(path), 86400, path);
    assert.deepEqual(tagsFor(path), ["blog"], path);
  }
  // Blog images cache themselves; deeper paths and the bare /blog/media are not pages.
  for (const path of ["/blog/media", "/blog/media/abc/hero", "/blog/tag", "/blog/a/b"]) assert.equal(ttlFor(path), 0, path);
  // The short-lived pages keep their five minutes and carry no tags.
  const home = forEdge(get("/"), new Response("x"));
  assert.equal(home.headers.get("Cache-Tag"), null);
  // A failed render is never kept, so it carries no tag either.
  assert.equal(forEdge(get("/p/x"), new Response("x", { status: 500 })).headers.get("Cache-Tag"), null);
});

test("a profile's tag is stable and differs between sites", () => {
  assert.match(profileTag("https://example.com"), /^p:[0-9a-f]{8}$/);
  assert.equal(profileTag("https://example.com"), profileTag("https://example.com"));
  assert.notEqual(profileTag("https://example.com"), profileTag("https://example.org"));
  // An undecodable slug still gets the bulk tag.
  assert.deepEqual(tagsFor("/p/%E0%A4%A"), ["profiles"]);
});

test("the cache key: profiles and the blog drop their query; every key carries the build's static files", () => {
  const key = (path) => new URL(edgeRequest(get(path), "abc123").url);
  assert.equal(key("/p/x?utm_source=hn&a=1").search, "?__a=abc123");
  assert.equal(key("/blog/a-post?ref=x").search, "?__a=abc123");
  // Other pages keep theirs: /play?mode=guess is a different page.
  assert.equal(key("/play?mode=guess").searchParams.get("mode"), "guess");
  assert.equal(key("/play?mode=guess").searchParams.get("__a"), "abc123");
  // Inside CachedPages the app sees the address without the fingerprint.
  assert.equal(appRequest(edgeRequest(get("/play?mode=guess"), "abc123")).url, `${BASE}/play?mode=guess`);
  assert.equal(appRequest(edgeRequest(get("/p/x?utm=1"), "abc123")).url, `${BASE}/p/x`);
});

test("share images are made once per change: kept like their page, tagged with it, their ?hash ignored", () => {
  const url = "https://example.com";
  const slug = encodeURIComponent(url);
  for (const path of [`/p/${slug}/opengraph-image`, `/p/${slug}/twitter-image`]) {
    assert.equal(mayUseEdgeCache(get(`${path}?c399de7409d3d8cb`), HOST), true, path);
    assert.equal(ttlFor(path), 86400, path);
    assert.deepEqual(tagsFor(path), ["profiles", profileTag(url)], path);
    assert.equal(new URL(edgeRequest(get(`${path}?c399de7409d3d8cb`), "abc").url).search, "?__a=abc");
  }
  for (const path of ["/blog/a-post/opengraph-image", "/blog/a-post/twitter-image"]) {
    assert.equal(ttlFor(path), 86400, path);
    assert.deepEqual(tagsFor(path), ["blog"], path);
  }
  assert.equal(ttlFor("/twitter-image"), 86400);
  // Grade reports' images stay private and uncached; other deeper paths are not pages.
  for (const path of ["/grade/abc/opengraph-image", "/p/x/other", "/blog/a/b"]) assert.equal(ttlFor(path), 0, path);
});
