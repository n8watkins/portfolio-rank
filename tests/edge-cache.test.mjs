// The edge cache's rules (worker/edge-cache.ts), offline: which requests may be
// answered from Workers Cache, and which responses may be kept there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forEdge, mayUseEdgeCache, probeAnswer, ttlFor } from "../worker/edge-cache.ts";

const HOST = "portfoliorank.n8builds.dev";
const BASE = `https://${HOST}`;

const get = (path, headers = {}) => new Request(`${BASE}${path}`, { headers });

test("public pages, sitemap, robots.txt and the share image may be cached", () => {
  for (const path of ["/", "/top", "/top/new", "/browse", "/play", "/play?mode=guess", "/how", "/grading", "/p/https%3A%2F%2Fexample.com", "/sitemap.xml", "/robots.txt", "/opengraph-image"]) {
    assert.equal(mayUseEdgeCache(get(path), HOST), true, path);
  }
});

test("the API, grade reports, personal pages and the admin never are", () => {
  for (const path of ["/api/polls", "/api/leaderboard", "/grade", "/grade/abc", "/me", "/profile", "/settings", "/votes", "/claim", "/admin/images", "/report/print", "/p/a/b"]) {
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
