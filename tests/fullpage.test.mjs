// Full-page screenshots (pipeline/fullpage.mjs): a real Chromium capture of
// local pages (the height caps, the crop flag, lazy images loaded by the
// scroll-through, WebP output, a failed frame that doesn't stop the other),
// the backfill's queue and bookkeeping on a throwaway database, and how the
// Worker serves the files (worker/shots.ts). Offline: no real site is visited.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  FULL_PAGE_FRAMES,
  FULL_PAGE_MAX_TRIES,
  captureFullPages,
  fullPageComplete,
  fullPageDue,
  nextTries,
  recordFullPage,
  shotHeight,
  tileRows,
  toWebp,
} from "../pipeline/fullpage.mjs";
import { PURGE_FILES, SERVE_FILES, contentTypeOf } from "../pipeline/shot-files.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb } from "../pipeline/roster.mjs";
import { SHOT_FILES, shotFor } from "../worker/shots.ts";
import { fullPageFrames } from "../lib/shot-url.ts";
import { fullPagePreviewEnabled } from "../lib/fullpage-flag.ts";

const isWebp = (buf) => buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";

// A page `h` px tall with a lazy image at the bottom (its request is counted).
const tallPage = (h) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;font-family:sans-serif}
section{height:${h - 400}px;background:linear-gradient(#123,#9ab)}</style></head>
<body><h1 style="margin:0;height:200px">Jane Doe</h1><section></section>
<img src="/lazy.png" loading="lazy" width="200" height="200" alt="lazy"></body></html>`;
// About 4,900 px tall; the image near the bottom gets its src only once it is in
// the viewport (a scroll-triggered reveal, as many portfolios do it).
const revealPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div style="height:4700px;background:#234"></div><img id="late" width="200" height="200" alt="late">
<script>window.revealed = false;
new IntersectionObserver((es, io) => { if (es.some((e) => e.isIntersecting)) { window.revealed = true; document.getElementById("late").src = "/lazy.png?" + Math.random(); io.disconnect(); } })
  .observe(document.getElementById("late"));</script></body></html>`;
// 3,000 px tall with a fixed red header, and a green block that is visible
// only while it is in view (hidden again when scrolled away, as
// scroll-linked effects do).
const inViewPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#fff"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#f00"></header>
<div style="height:1200px"></div><div id="block" style="height:300px;background:#0a0;opacity:0"></div><div style="height:1500px"></div>
<script>new IntersectionObserver((es) => { for (const e of es) e.target.style.opacity = e.isIntersecting ? "1" : "0"; })
  .observe(document.getElementById("block"));</script></body></html>`;
const shortPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>Short page</h1></body></html>`;
// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let server;
let base;
let lazyHits = 0;
let browser;
let tmp;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/lazy.png")) {
      lazyHits++;
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    } else if (req.url === "/tall") res.writeHead(200, { "content-type": "text/html" }).end(tallPage(12000));
    else if (req.url === "/in-view") res.writeHead(200, { "content-type": "text/html" }).end(inViewPage);
    else if (req.url === "/reveal") res.writeHead(200, { "content-type": "text/html" }).end(revealPage);
    else res.writeHead(200, { "content-type": "text/html" }).end(shortPage);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fullpage-"));
});
after(async () => {
  await browser?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function pages(url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktop = await ctx.newPage();
  await desktop.goto(url);
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(url);
  return { ctx, desktop, phone };
}

test("height: at least a viewport, at most the cap, cropped only when the page is taller", () => {
  assert.deepEqual(shotHeight(3000, 900, 6000), { height: 3000, cropped: false });
  assert.deepEqual(shotHeight(6000, 900, 6000), { height: 6000, cropped: false });
  assert.deepEqual(shotHeight(6001, 900, 6000), { height: 6000, cropped: true });
  assert.deepEqual(shotHeight(400, 900, 6000), { height: 900, cropped: false });
  assert.deepEqual(shotHeight(NaN, 844, 8000), { height: 844, cropped: false });
  assert.equal(FULL_PAGE_FRAMES.desktop.maxHeight, 6000);
  assert.equal(FULL_PAGE_FRAMES.phone.maxHeight, 8000);
});

test("WebP encoding keeps the size and is a WebP", async () => {
  const { data, width, height, bytes } = await toWebp(PNG);
  assert.ok(isWebp(data));
  assert.equal(width, 1);
  assert.equal(height, 1);
  assert.equal(bytes, data.length);
});

test("a tall page: both frames cropped at their caps, as WebP", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "tall-"));
  const { ctx, desktop, phone } = await pages(`${base}/tall`);

  const fp = await captureFullPages({ desktop, phone }, dir, { now: () => new Date("2026-11-13T10:00:00Z") });
  await ctx.close();
  assert.equal(fp.at, "2026-11-13T10:00:00.000Z");
  assert.deepEqual([fp.desktop.width, fp.desktop.height, fp.desktop.cropped], [1440, 6000, true]);
  assert.deepEqual([fp.phone.width, fp.phone.height, fp.phone.cropped], [390, 8000, true]);
  assert.ok(fp.desktop.pageHeight >= 12000, "the page's own height is recorded");
  for (const f of ["full-desktop.webp", "full-phone.webp"]) {
    const buf = fs.readFileSync(path.join(dir, f));
    assert.ok(isWebp(buf), `${f} is WebP`);
  }
  assert.equal(fp.desktop.bytes, fs.statSync(path.join(dir, "full-desktop.webp")).size);
  assert.ok(fullPageComplete(fp));
});

test("content that loads when scrolled into view is there before the shot", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "lazy-"));
  const { ctx, desktop, phone } = await pages(`${base}/reveal`);
  assert.equal(await desktop.evaluate(() => window.revealed), false, "not loaded before the scroll");
  const fp = await captureFullPages({ desktop, phone }, dir);
  assert.equal(await desktop.evaluate(() => window.revealed), true, "the scroll-through reached it");
  assert.equal(await phone.evaluate(() => window.revealed), true);
  await ctx.close();
  assert.ok(lazyHits >= 2, "its image was requested for both frames");
  assert.equal(fp.desktop.cropped, false);
  assert.ok(fp.desktop.height >= 4900 && fp.desktop.height < 6000, `desktop ${fp.desktop.height}`);
});

test("stitched per screenful: content shown only while in view is there, a fixed header shows once", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "in-view-"));
  const { ctx, desktop, phone } = await pages(`${base}/in-view`);
  const fp = await captureFullPages({ desktop, phone }, dir);
  await ctx.close();
  assert.deepEqual([fp.desktop.width, fp.desktop.height, fp.desktop.cropped], [1440, 3000, false]);
  const { data, info } = await sharp(path.join(dir, "full-desktop.webp")).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);
  assert.ok(near(px(720, 30), [255, 0, 0]), "the header at the top");
  assert.ok(near(px(720, 1350), [0, 170, 0]), `the in-view block is shown, got ${px(720, 1350)}`);
  for (const y of [930, 1830, 2730]) assert.ok(near(px(720, y), [255, 255, 255]), `no header repeated at ${y}, got ${px(720, y)}`);
});

test("tile rows: the part of each screenful the image still needs", () => {
  assert.deepEqual(tileRows({ y: 0, actual: 0, viewportHeight: 900, height: 3000 }), { offset: 0, rows: 900 });
  assert.deepEqual(tileRows({ y: 2700, actual: 2100, viewportHeight: 900, height: 3000 }), { offset: 600, rows: 300 }, "the browser stopped at the bottom");
  assert.deepEqual(tileRows({ y: 5400, actual: 5400, viewportHeight: 900, height: 6000 }), { offset: 0, rows: 600 }, "cut at the cap");
  assert.equal(tileRows({ y: 900, actual: 0, viewportHeight: 900, height: 3000 }), null, "the page stopped scrolling");
});

test("a short page is one viewport tall; a frame that fails is recorded and the other is still taken", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "short-"));
  fs.writeFileSync(path.join(dir, "full-phone.webp"), "stale");
  const { ctx, desktop, phone } = await pages(`${base}/`);
  await phone.close();
  const fp = await captureFullPages({ desktop, phone }, dir);
  await ctx.close();
  assert.deepEqual([fp.desktop.width, fp.desktop.height, fp.desktop.cropped], [1440, 900, false]);
  assert.ok(fp.phone.error, "the closed page is an error, not a throw");
  assert.equal(fs.existsSync(path.join(dir, "full-phone.webp")), false, "no stale file is left to upload");
  assert.equal(fullPageComplete(fp), false);
});

test("stored files: served, uploaded and purged", () => {
  assert.deepEqual([...SERVE_FILES], ["hero.jpg", "mobile.jpg", "full-desktop.webp", "full-phone.webp"]);
  for (const f of SERVE_FILES) assert.ok(PURGE_FILES.includes(f), `the purge deletes ${f}`);
  assert.ok(PURGE_FILES.includes("full.jpg"), "and the old full.jpg");
  assert.equal(contentTypeOf("full-desktop.webp"), "image/webp");
  assert.equal(contentTypeOf("hero.jpg"), "image/jpeg");
  assert.deepEqual(Object.keys(SHOT_FILES).sort(), [...SERVE_FILES].sort(), "the Worker serves what the capture stores");
});

test("backfill queue: never tried first, retries a week apart, three tries at most, listed live sites only", async () => {
  process.env.LOCAL_DB_FILE = path.join(tmp, "backfill.db");
  const db = pipelineDb(tmp);
  await ensureRosterSchema(db);
  const now = Date.parse("2026-11-13T12:00:00Z");
  const done = { at: "2026-11-01T00:00:00Z", desktop: { width: 1440, height: 3000, bytes: 100 }, phone: { width: 390, height: 5000, bytes: 90 } };
  const failedOld = { at: "2026-11-01T00:00:00Z", desktop: { error: "x" }, phone: { error: "x" }, tries: 1 };
  const failedNew = { at: "2026-11-12T00:00:00Z", desktop: { error: "x" }, phone: { error: "x" }, tries: 1 };
  const failedOut = { at: "2026-10-01T00:00:00Z", desktop: { error: "x" }, phone: { error: "x" }, tries: FULL_PAGE_MAX_TRIES };
  const rows = [
    ["https://new.test", "live", "aaaaaaaaaaaaaaa1", { domHash: "d" }, "2026-11-10 00:00:00", null],
    ["https://older.test", "live", "aaaaaaaaaaaaaaa2", { domHash: "d" }, "2026-10-10 00:00:00", null],
    ["https://nometa.test", "live", "aaaaaaaaaaaaaaa3", null, "2026-10-01 00:00:00", null],
    ["https://done.test", "live", "aaaaaaaaaaaaaaa4", { fullPage: done }, "2026-11-01 00:00:00", null],
    ["https://retry.test", "live", "aaaaaaaaaaaaaaa5", { fullPage: failedOld }, "2026-11-11 00:00:00", null],
    ["https://wait.test", "live", "aaaaaaaaaaaaaaa6", { fullPage: failedNew }, "2026-11-11 00:00:00", null],
    ["https://gaveup.test", "live", "aaaaaaaaaaaaaaa7", { fullPage: failedOut }, "2026-11-11 00:00:00", null],
    ["https://delisted.test", "live", "aaaaaaaaaaaaaaa8", {}, "2026-11-11 00:00:00", "2026-11-01"],
    ["https://dead.test", "dead", "aaaaaaaaaaaaaaa9", {}, "2026-11-11 00:00:00", null],
  ];
  for (const [url, status, key, meta, at, delisted] of rows) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, status, shot_key, meta, captured_at, delisted_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [url, status, key, meta ? JSON.stringify(meta) : null, at, delisted],
    });
  }
  const due = await fullPageDue(db, { limit: 10, active: ACTIVE, now });
  assert.deepEqual(
    due.map((r) => r.url),
    ["https://new.test", "https://older.test", "https://nometa.test", "https://retry.test"]
  );
  assert.equal((await fullPageDue(db, { limit: 2, active: ACTIVE, now })).length, 2, "the per-run cap");

  // Recording keeps everything else in the row as it was.
  assert.equal(nextTries(null), 1);
  assert.equal(nextTries({ at: "x" }), 2, "a try by the capture counts as one");
  assert.equal(nextTries(failedOld), 2);
  const fp = { ...done, at: "2026-11-13T12:00:00Z", tries: 1 };
  assert.equal(await recordFullPage(db, { url: "https://new.test", shotKey: "aaaaaaaaaaaaaaa1", fullPage: fp }), 1);
  assert.equal(await recordFullPage(db, { url: "https://nometa.test", shotKey: "aaaaaaaaaaaaaaa3", fullPage: fp }), 1);
  assert.equal(await recordFullPage(db, { url: "https://older.test", shotKey: "0000000000000000", fullPage: fp }), 0, "not after a new capture");
  const row = (await db.execute("SELECT meta, captured_at FROM portfolios WHERE url = 'https://new.test'")).rows[0];
  assert.deepEqual(JSON.parse(String(row.meta)), { domHash: "d", fullPage: fp });
  assert.equal(row.captured_at, "2026-11-10 00:00:00");
  const remaining = (await fullPageDue(db, { limit: 10, active: ACTIVE, now })).map((r) => r.url);
  assert.deepEqual(remaining, ["https://older.test", "https://retry.test"]);
  db.close();
  delete process.env.LOCAL_DB_FILE;
});

test("the Worker serves the full-page frames as WebP with the hero's caching", async () => {
  const stored = new Map([
    ["0123456789abcdef/full-desktop.webp", "D"],
    ["0123456789abcdef/full-phone.webp", "P"],
    ["0123456789abcdef/hero.jpg", "H"],
  ]);
  const env = {
    SHOTS: {
      async get(key) {
        return stored.has(key) ? { body: new Response(stored.get(key)).body, httpEtag: `"${key}"` } : null;
      },
    },
  };
  const at = (p) => shotFor(new URL(`https://portfoliorank.test${p}`), env);
  let res = await at("/shots/0123456789abcdef/full-desktop.webp?v=t1abc")();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "D");
  res = await at("/shots/0123456789abcdef/full-phone.webp")();
  assert.equal(res.headers.get("cache-control"), "public, max-age=86400", "unversioned: a day");
  res = await at("/shots/0123456789abcdef/hero.jpg?v=t1abc")();
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  res = await at("/shots/fedcba9876543210/full-desktop.webp?v=1")();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  for (const p of ["/shots/0123456789abcdef/full.jpg", "/shots/0123456789abcdef/other.webp", "/shots/private/grades/x/hero.jpg", "/shots/0123456789abcdef/../hero.jpg"]) {
    assert.equal(at(p), null, `${p} is not a screenshot`);
  }
});

test("preview URLs: only with both frames, versioned by the frames' own time; the switch is off by default", () => {
  const fp = { at: "2026-11-13T10:00:00Z", desktop: { width: 1440, height: 6000, cropped: true, bytes: 5 }, phone: { width: 390, height: 7000, bytes: 4 } };
  const v = Math.floor(Date.parse(fp.at) / 1000).toString(36);
  assert.deepEqual(fullPageFrames("/shots/0123456789abcdef?v=old", fp), {
    desktop: { src: `/shots/0123456789abcdef/full-desktop.webp?v=${v}`, width: 1440, height: 6000, cropped: true },
    phone: { src: `/shots/0123456789abcdef/full-phone.webp?v=${v}`, width: 390, height: 7000, cropped: false },
  });
  assert.equal(fullPageFrames("/shots/k", { ...fp, phone: { error: "timeout" } }), null);
  assert.equal(fullPageFrames("/shots/k", null), null);
  assert.equal(fullPagePreviewEnabled({}), false);
  assert.equal(fullPagePreviewEnabled({ FULLPAGE_PREVIEW_ENABLED: "false" }), false);
  assert.equal(fullPagePreviewEnabled({ FULLPAGE_PREVIEW_ENABLED: "true" }), true);
  const wrangler = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  const values = [...wrangler.matchAll(/"FULLPAGE_PREVIEW_ENABLED":\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ["false", "false"], "off in production and on staging");
});
