// lib/sitemaps.mjs: the sitemap index and its parts' XML, the profiles cut
// into files, and lastmod times.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES_PER_FILE, chunk, isoTime, latest, newest, parsePart, sitemapIndexXml, urlsetXml } from "../lib/sitemaps.mjs";

test("a urlset lists each URL, with a lastmod only when one is known, and escapes them", () => {
  const xml = urlsetXml([{ url: "https://portfoliorank.dev/p/a.dev", lastmod: "2026-11-05T08:30:00.000Z" }, { url: "https://portfoliorank.dev/?a=1&b=2" }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes("<url><loc>https://portfoliorank.dev/p/a.dev</loc><lastmod>2026-11-05T08:30:00.000Z</lastmod></url>"));
  assert.ok(xml.includes("<url><loc>https://portfoliorank.dev/?a=1&amp;b=2</loc></url>"));
  assert.ok(!/changefreq|priority/.test(xml));
});

test("the index lists its parts with their newest lastmod", () => {
  const xml = sitemapIndexXml([{ url: "https://x.dev/sitemap/pages.xml" }, { url: "https://x.dev/sitemap/blog.xml", lastmod: "2026-11-01T00:00:00.000Z" }]);
  assert.ok(xml.includes('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes("<sitemap><loc>https://x.dev/sitemap/pages.xml</loc></sitemap>"));
  assert.ok(xml.includes("<sitemap><loc>https://x.dev/sitemap/blog.xml</loc><lastmod>2026-11-01T00:00:00.000Z</lastmod></sitemap>"));
  assert.equal(newest([{ lastmod: "2026-11-01T00:00:00.000Z" }, { lastmod: null }, { lastmod: "2026-11-03T00:00:00.000Z" }]), "2026-11-03T00:00:00.000Z");
  assert.equal(newest([{ lastmod: null }]), null);
});

test("profiles go in files of 10,000, well under the 50,000 a sitemap may hold, and there is always one", () => {
  assert.equal(PROFILES_PER_FILE, 10_000);
  const files = chunk(Array.from({ length: 50_001 }, (_, i) => i));
  assert.deepEqual(files.map((f) => f.length), [10_000, 10_000, 10_000, 10_000, 10_000, 1]);
  assert.equal(files[5][0], 50_000);
  assert.deepEqual(chunk([]), [[]]);
});

test("times: ISO kept, SQLite's datetime read as UTC, junk and nothing are unknown", () => {
  assert.equal(isoTime("2026-11-05T08:30:00.000Z"), "2026-11-05T08:30:00.000Z");
  assert.equal(isoTime("2026-11-05 08:30:00"), "2026-11-05T08:30:00.000Z");
  assert.equal(isoTime(Date.UTC(2026, 10, 5)), "2026-11-05T00:00:00.000Z");
  for (const t of [null, undefined, "", "soon", 0]) assert.equal(isoTime(t), null, String(t));
  assert.equal(latest("2026-11-01 00:00:00", null, "2026-11-02T00:00:00Z", "junk"), "2026-11-02T00:00:00.000Z");
  assert.equal(latest(null, undefined), null);
});

test("only the known part names are served", () => {
  assert.deepEqual(parsePart("pages.xml"), { kind: "pages" });
  assert.deepEqual(parsePart("blog.xml"), { kind: "blog" });
  assert.deepEqual(parsePart("profiles-1.xml"), { kind: "profiles", n: 1 });
  assert.deepEqual(parsePart("profiles-12.xml"), { kind: "profiles", n: 12 });
  for (const raw of ["profiles-0.xml", "profiles-01.xml", "profiles.xml", "pages", "../etc.xml", "PAGES.xml", "profiles-1.xml.gz"]) assert.equal(parsePart(raw), null, raw);
});
