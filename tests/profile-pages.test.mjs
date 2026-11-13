// Profile pages at their readable address, end to end against the running
// production build (scripts/test-e2e.sh): /p/<host><path> renders with that
// one canonical and its share image at /og/p/<same>; every other form of the
// address (the old encoded one, its decoded and Next.js-collapsed forms,
// www, another case) is a permanent redirect there; an unknown site is a 404.
// The Worker answers the old forms itself with a 301 before Next.js runs
// (worker/profile-redirect.ts, tests/profile-url.test.mjs); here nothing is
// in front, so the page's own redirect (308) is what's checked.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import feed from "../data/feed.json" with { type: "json" };
import { profilePath } from "../lib/profile-url.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const hasPath = (url) => new URL(url).pathname.replace(/\/+$/, "") !== "";
const plain = feed.find((p) => !hasPath(p.url) && !new URL(p.url).search);
const deep = feed.find((p) => hasPath(p.url) && /[A-Z]/.test(new URL(p.url).pathname) && !new URL(p.url).search);
const get = (path) => fetch(BASE + path, { redirect: "manual" });

test("a profile renders at its readable address, with that one canonical and its share image", async () => {
  for (const p of [plain, deep]) {
    const path = profilePath(p.url);
    assert.ok(!path.includes("%3A"), path);
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    assert.ok(canonical?.endsWith(path), `${path}: canonical ${canonical}`);
    const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    assert.ok(image?.endsWith(path.replace(/^\/p\//, "/og/p/")), `${path}: og:image ${image}`);
  }
});

test("every other form of a profile's address redirects to the readable one for good", async () => {
  const u = new URL(deep.url);
  const target = profilePath(deep.url);
  const forms = [
    `/p/${encodeURIComponent(deep.url)}`,
    `/p/${u.protocol}/${u.host}${u.pathname}`,
    `/p/${u.host.toUpperCase()}${u.pathname}`,
    `/p/www.${u.host.replace(/^www\./, "")}${u.pathname}`,
    `/p/${u.host}${u.pathname.toLowerCase()}`,
  ];
  for (const from of forms) {
    const res = await get(from);
    assert.ok([301, 308].includes(res.status), `${from}: ${res.status}`);
    assert.equal(new URL(res.headers.get("location"), BASE).pathname, target, from);
  }
});

test("an unknown site is a 404, page and share image alike", async () => {
  assert.equal((await get("/p/no-such-portfolio.example")).status, 404);
  assert.equal((await get("/p/no-such-portfolio.example/deep/path")).status, 404);
  assert.equal((await get("/og/p/no-such-portfolio.example")).status, 404);
  assert.equal((await get("/p/%E0%A4%A")).status, 404);
});

test("the share image answers at /og/p/<address>", async () => {
  const res = await get(profilePath(plain.url).replace(/^\/p\//, "/og/p/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});
