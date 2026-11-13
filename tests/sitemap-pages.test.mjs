// The sitemap index and its parts, end to end against the running
// production build (scripts/test-e2e.sh): /sitemap.xml lists the pages, blog
// and profile files; a profiles file lists graded profiles with their
// lastmod and leaves ungraded ones out; unknown parts are a 404.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";
import { profilePath } from "../lib/profile-url.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const get = (path) => fetch(BASE + path, { redirect: "manual" });
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const JUDGED_AT = "2026-11-01T10:00:00.000Z";
// Two sites from the middle of the list, which the profile tests don't use.
const [graded, ungraded] = feed.slice(1000, 1002);

test("the sitemap is an index of pages, blog and profile files", async () => {
  const res = await get("/sitemap.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/xml/);
  const xml = await res.text();
  assert.match(xml, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  // `next build` prerenders the index (refreshed daily), so here it reflects the build's empty
  // database: one profiles file, and its lastmod checked in tests/sitemaps.test.mjs instead.
  assert.deepEqual(locs(xml).map((u) => new URL(u).pathname), ["/sitemap/pages.xml", "/sitemap/blog.xml", "/sitemap/profiles-1.xml"]);
});

test("a profiles file lists graded profiles with the time they last changed, and leaves ungraded ones out", async () => {
  await db.execute({
    sql: `INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)
          ON CONFLICT(url) DO UPDATE SET status = 'live', health = NULL, ai_rubric = excluded.ai_rubric`,
    args: [graded.url, JSON.stringify({ tier: "A", is_portfolio: true, judged_at: JUDGED_AT })],
  });
  await db.execute({ sql: "DELETE FROM ratings WHERE url = ?", args: [graded.url] });
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = NULL WHERE url = ?", args: [ungraded.url] });
  const xml = await (await get("/sitemap/profiles-1.xml")).text();
  assert.match(xml, /<urlset /);
  assert.ok(!/changefreq|priority/.test(xml));
  const loc = profilePath(graded.url);
  const entry = xml.match(new RegExp(`<url><loc>[^<]*${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>(<lastmod>[^<]+</lastmod>)?</url>`));
  assert.ok(entry, "the graded profile is listed");
  assert.equal(entry[1], `<lastmod>${JUDGED_AT}</lastmod>`);
  assert.ok(!xml.includes(`${profilePath(ungraded.url)}</loc>`), "the ungraded one isn't");
});

test("the pages and blog parts answer; unknown parts are a 404", async () => {
  assert.match(await (await get("/sitemap/pages.xml")).text(), /\/grading<\/loc>/);
  assert.equal((await get("/sitemap/blog.xml")).status, 200);
  for (const path of ["/sitemap/profiles-2.xml", "/sitemap/nope.xml", "/sitemap/profiles-0.xml"]) assert.equal((await get(path)).status, 404, path);
});
