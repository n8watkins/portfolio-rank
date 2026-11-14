// The capture's page images (pipeline/fullpage.mjs): a real Chromium capture
// of local pages (height caps and the crop flag, tall images stitched per
// screenful so content shown only in view is there, a fixed header once,
// scroll-loaded content, AVIF files and thumbnails, the JPEG crops for the
// grade), the "looks the same" check that skips uploads, the versioned R2
// writes (pipeline/shot-store.mjs), the backfill's queue on a throwaway
// database, and how the Worker serves the files (worker/shots.ts).
// Offline: no real site is visited.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  FRAMES,
  FULL_PAGE_MAX_TRIES,
  IMAGE_FILES,
  captureView,
  fullPageComplete,
  fullPageDue,
  nextFullPage,
  nextTries,
  recordFullPage,
  sameLook,
  shotHeight,
  textHash,
  tileRows,
  versionOf,
  VIEW_BUDGET_MS,
} from "../pipeline/fullpage.mjs";
import { captureOnce } from "../pipeline/capture-once.mjs";
import { IMMUTABLE, deleteAllShots, imageKey, imagesBucket, legacyFramesOn, notStored, storeVersion } from "../pipeline/shot-store.mjs";
import { SERVE_FILES, contentTypeOf } from "../pipeline/shot-files.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb } from "../pipeline/roster.mjs";
import { SHOT_FILES, shotFor } from "../worker/shots.ts";
import { fullPageFrames } from "../lib/shot-url.ts";
import { fullPagePreviewEnabled } from "../lib/fullpage-flag.ts";

const isAvif = (buf) => buf.subarray(4, 12).toString("ascii") === "ftypavif";
const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8;

// A page `h` px tall.
const tallPage = (h) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;font-family:sans-serif}
section{height:${h - 200}px;background:linear-gradient(#123,#9ab)}</style></head>
<body><h1 style="margin:0;height:200px">Jane Doe</h1><section></section></body></html>`;
// About 4,900 px tall; the image near the bottom gets its src only once it is in
// the viewport (a scroll-triggered reveal, as many portfolios do it).
const revealPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0"><div style="height:3500px;background:#234"></div><img id="late" width="200" height="200" alt="late">
<script>window.revealed = false;
new IntersectionObserver((es, io) => { if (es.some((e) => e.isIntersecting)) { window.revealed = true; document.getElementById("late").src = "/lazy.png?" + Math.random(); io.disconnect(); } })
  .observe(document.getElementById("late"));</script></body></html>`;
// 3,000 px tall with a fixed red header, and a green block that is visible
// only while it is in view (hidden again when scrolled away, as
// scroll-linked effects do). ?color= changes the block.
const inViewPage = (color = "#0a0") => `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#fff"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#f00"></header>
<div style="height:1200px"></div><div id="block" style="height:600px;background:${color};opacity:0"></div><div style="height:1200px"></div>
<script>new IntersectionObserver((es) => { for (const e of es) e.target.style.opacity = e.isIntersecting ? "1" : "0"; })
  .observe(document.getElementById("block"));</script></body></html>`;
// html and body one screen tall; a red header 100 px tall, then a <main>
// that scrolls (smoothly, with snapping) through 2,500 px: a green block at
// 1,500 to 1,800 of its content, under the "Projects" heading.
const innerPage = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
html, body { height: 100%; margin: 0; overflow: hidden; background: #fff; font-family: sans-serif; }
header { height: 100px; background: #f00; }
main { height: calc(100% - 100px); overflow-y: auto; scroll-behavior: smooth; scroll-snap-type: y mandatory; }
section { scroll-snap-align: start; }
</style></head><body><header></header><main>
<section style="height:1400px"><h1 style="margin:0">Jane Doe</h1></section>
<section style="height:1100px"><h2 style="margin:0;height:100px">Projects</h2><div style="height:300px;background:#0a0"></div></section>
</main></body></html>`;
const shortPage =`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>Short page</h1></body></html>`;
// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let server;
let base;
let lazyHits = 0;
let browser;
let tmp;
before(async () => {
  server = http.createServer((req, res) => {
    const html = (body) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (req.url.startsWith("/lazy.png")) {
      lazyHits++;
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    } else if (req.url === "/tall") html(tallPage(12000));
    else if (req.url === "/reveal") html(revealPage);
    else if (req.url === "/in-view") html(inViewPage());
    else if (req.url === "/in-view-blue") html(inViewPage("#00a"));
    else if (req.url === "/inner") html(innerPage);
    else html(shortPage);
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

/** Both views of a local page, as the capture takes them. */
async function views(pathname) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const desktop = await ctx.newPage();
    await desktop.goto(`${base}${pathname}`);
    const d = await captureView(desktop, "desktop");
    const phone = await ctx.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${base}${pathname}`);
    const p = await captureView(phone, "phone");
    return { desktop: d, phone: p, pages: { desktop, phone } };
  } finally {
    await ctx.close();
  }
}

const pixels = async (buf) => {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { info, at: (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)] };
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);

test("height: at least a viewport, at most the cap (4,000 desktop, 6,000 phone), cropped only when taller", () => {
  assert.deepEqual(shotHeight(3000, 900, 4000), { height: 3000, cropped: false });
  assert.deepEqual(shotHeight(4000, 900, 4000), { height: 4000, cropped: false });
  assert.deepEqual(shotHeight(4001, 900, 4000), { height: 4000, cropped: true });
  assert.deepEqual(shotHeight(400, 900, 4000), { height: 900, cropped: false });
  assert.deepEqual(shotHeight(NaN, 844, 6000), { height: 844, cropped: false });
  assert.equal(FRAMES.desktop.maxHeight, 4000);
  assert.equal(FRAMES.phone.maxHeight, 6000);
});

test("tile rows: the part of each screenful the image still needs", () => {
  assert.deepEqual(tileRows({ y: 0, actual: 0, viewportHeight: 900, height: 3000 }), { offset: 0, rows: 900 });
  assert.deepEqual(tileRows({ y: 2700, actual: 2100, viewportHeight: 900, height: 3000 }), { offset: 600, rows: 300 }, "the browser stopped at the bottom");
  assert.deepEqual(tileRows({ y: 3600, actual: 3600, viewportHeight: 900, height: 4000 }), { offset: 0, rows: 400 }, "cut at the cap");
  assert.equal(tileRows({ y: 900, actual: 0, viewportHeight: 900, height: 3000 }), null, "the page stopped scrolling");
});

test("a tall page: AVIF tall images cut at their caps, AVIF thumbnails, JPEG crops of the top for the grade", async () => {
  const { desktop, phone } = await views("/tall");
  assert.ok(desktop.ok && phone.ok);
  assert.deepEqual([desktop.meta.width, desktop.meta.height, desktop.meta.cropped], [1440, 4000, true]);
  assert.deepEqual([phone.meta.width, phone.meta.height, phone.meta.cropped], [390, 6000, true]);
  assert.ok(desktop.meta.pageHeight >= 12000, "the page's own height is recorded");
  for (const [v, thumbWidth, topW, topH] of [[desktop, 480, 1440, 900], [phone, 240, 390, 844]]) {
    assert.ok(isAvif(v.files.tall) && isAvif(v.files.thumb), "tall image and thumbnail are AVIF");
    assert.equal(v.meta.bytes, v.files.tall.length);
    assert.equal(v.meta.thumbBytes, v.files.thumb.length);
    assert.equal((await sharp(v.files.thumb).metadata()).width, thumbWidth);
    assert.ok(isJpeg(v.files.crop), "the grade's crop is a JPEG (Gemini reads no AVIF)");
    const m = await sharp(v.files.crop).metadata();
    assert.deepEqual([m.width, m.height], [topW, topH], "the crop is the top screenful");
  }
});

test("stitched per screenful: content shown only while in view is there, a fixed header shows once", async () => {
  const { desktop } = await views("/in-view");
  assert.deepEqual([desktop.meta.width, desktop.meta.height, desktop.meta.cropped], [1440, 3000, false]);
  const px = await pixels(desktop.files.tall);
  assert.ok(near(px.at(720, 30), [255, 0, 0]), "the header at the top");
  assert.ok(near(px.at(720, 1500), [0, 170, 0]), `the in-view block is shown, got ${px.at(720, 1500)}`);
  for (const y of [930, 1830, 2730]) assert.ok(near(px.at(720, y), [255, 255, 255]), `no header repeated at ${y}, got ${px.at(720, y)}`);
});

test("content that loads when scrolled into view is there before the shot", async () => {
  lazyHits = 0;
  const { desktop, pages } = await views("/reveal");
  assert.ok(desktop.ok);
  assert.ok(lazyHits >= 2, "its image was requested for both views");
  assert.equal(desktop.meta.cropped, false);
  assert.ok(desktop.meta.height >= 3700 && desktop.meta.height < 4000, `desktop ${desktop.meta.height}`);
  assert.ok(pages.desktop.isClosed(), "the pages close with their context");
});

test("a page that scrolls inside an element: that element is scrolled and stitched, smooth scroll and snapping set aside", async () => {
  const { desktop } = await views("/inner");
  assert.ok(desktop.ok, desktop.meta.error);
  assert.equal(desktop.meta.scroller, "main");
  assert.deepEqual([desktop.meta.width, desktop.meta.height, desktop.meta.cropped], [1440, 2600, false], "the header, then all 2,500 px of the content");
  const px = await pixels(desktop.files.tall);
  assert.ok(near(px.at(720, 50), [255, 0, 0]), "the header on top");
  assert.ok(near(px.at(720, 100 + 1650), [0, 170, 0]), `the block 1,650 px into the content, got ${px.at(720, 1750)}`);
  for (const y of [1000, 1900, 2550]) assert.ok(near(px.at(720, y), [255, 255, 255]), `no header repeated at ${y}, got ${px.at(720, y)}`);
  const projects = desktop.meta.outline.find((h) => h.text === "Projects");
  assert.deepEqual([projects.level, projects.y], [2, 1500], "the heading's row on the tall image");
  assert.deepEqual([desktop.meta.outline[0].text, desktop.meta.outline[0].y], ["Jane Doe", 100]);
});

test("the time budget: no new tile once a view's time is up, and the image says so", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/tall`);
  const t = Date.now();
  const v = await captureView(page, "desktop", { budgetMs: 1500 });
  await ctx.close();
  assert.ok(v.ok);
  assert.equal(v.meta.timeCut, true);
  assert.ok(v.meta.height >= 900 && v.meta.height < 4000, `cut short at ${v.meta.height}`);
  assert.ok(Date.now() - t < 12000, "bounded");
  assert.equal(VIEW_BUDGET_MS, 13000, "about 30 s a site for both views, encoding included");
});

test("captureOnce: one visit, both views, the first-screen crops the grade reads, the text", async () => {
  const r = await captureOnce(browser, `${base}/inner`);
  assert.ok(r.desktop.ok && r.phone.ok);
  assert.match(r.text, /Jane Doe/);
  const d = await sharp(r.desktop.files.crop).metadata();
  const p = await sharp(r.phone.files.crop).metadata();
  assert.deepEqual([d.format, d.width, d.height, p.width, p.height], ["jpeg", 1440, 900, 390, 844]);
  assert.equal(r.phone.meta.scroller, "main");
});

test("a short page is one viewport tall; a view that fails is an error, never a throw", async () => {
  const { desktop } = await views("/");
  assert.deepEqual([desktop.meta.width, desktop.meta.height, desktop.meta.cropped], [1440, 900, false]);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.close();
  const failed = await captureView(page, "phone");
  await ctx.close();
  assert.equal(failed.ok, false);
  assert.ok(failed.meta.error);
});

test("looks the same: no new version and no upload; a visual or text change makes one", async () => {
  const a = await views("/in-view");
  const b = await views("/in-view");
  const c = await views("/in-view-blue");
  assert.ok(sameLook(a.desktop.meta.sig, b.desktop.meta.sig), "two captures of the same page");
  assert.equal(sameLook(a.desktop.meta.sig, c.desktop.meta.sig), false, "a block changed colour");

  const t0 = new Date("2026-11-13T10:00:00Z");
  const first = nextFullPage(null, { desktopView: a.desktop, phoneView: a.phone, pageText: "Jane Doe", at: t0 });
  assert.equal(first.uploadImages, true);
  assert.equal(first.fullPage.v, versionOf(t0));
  assert.ok(fullPageComplete(first.fullPage));

  const t1 = new Date("2026-11-20T10:00:00Z");
  const same = nextFullPage(first.fullPage, { desktopView: b.desktop, phoneView: b.phone, pageText: "Jane Doe", at: t1 });
  assert.deepEqual([same.uploadImages, same.uploadLegacy], [false, false], "nothing written");
  assert.equal(same.fullPage.v, first.fullPage.v, "the stored version stays");
  assert.equal(same.fullPage.checkedAt, t1.toISOString());

  const looks = nextFullPage(first.fullPage, { desktopView: c.desktop, phoneView: c.phone, pageText: "Jane Doe", at: t1 });
  assert.equal(looks.uploadImages, true);
  assert.equal(looks.fullPage.v, versionOf(t1));
  const words = nextFullPage(first.fullPage, { desktopView: b.desktop, phoneView: b.phone, pageText: "Jane Doe, hired", at: t1 });
  assert.equal(words.uploadImages, true, "a text change is never taken for the same look");

  const failed = { ok: false, meta: { error: "timeout" } };
  const keep = nextFullPage(first.fullPage, { desktopView: a.desktop, phoneView: failed, pageText: "", at: t1 });
  assert.deepEqual([keep.uploadImages, keep.uploadLegacy, keep.fullPage.v], [false, true, first.fullPage.v], "a failed view keeps the stored version");
  assert.equal(keep.fullPage.lastError.phone.error, "timeout");
  const none = nextFullPage(null, { desktopView: failed, phoneView: failed, pageText: "", at: t1 });
  assert.deepEqual([none.uploadImages, none.fullPage.tries, fullPageComplete(none.fullPage)], [false, 1, false]);
  assert.equal(textHash("a"), textHash("a"));
});

test("R2 writes: four immutable AVIF files under the version, then the old version deleted; the purge stays in its prefix", async () => {
  const sent = [];
  const commands = {
    PutObjectCommand: class { constructor(input) { this.name = "put"; this.input = input; } },
    DeleteObjectsCommand: class { constructor(input) { this.name = "delete"; this.input = input; } },
    ListObjectsV2Command: class { constructor(input) { this.name = "list"; this.input = input; } },
  };
  const send = async (c) => {
    sent.push(c);
    if (c.name === "list") return { Contents: [{ Key: "0123456789abcdef/hero.jpg" }, { Key: "0123456789abcdef/abc/desktop.avif" }], IsTruncated: false };
    return {};
  };
  const files = Object.fromEntries(Object.values(IMAGE_FILES).flatMap((f) => [[f.tall, Buffer.from("t")], [f.thumb, Buffer.from("s")]]));
  assert.equal(await storeVersion({ send, commands, bucket: "b", shotKey: "0123456789abcdef", v: "new1", prevV: "old1", files }), 4);
  const puts = sent.filter((c) => c.name === "put");
  assert.deepEqual(puts.map((c) => c.input.Key).sort(), ["desktop-thumb.avif", "desktop.avif", "phone-thumb.avif", "phone.avif"].map((f) => imageKey("0123456789abcdef", "new1", f)));
  for (const p of puts) assert.deepEqual([p.input.ContentType, p.input.CacheControl], ["image/avif", IMMUTABLE]);
  const del = sent.find((c) => c.name === "delete");
  assert.deepEqual(del.input.Delete.Objects.map((o) => o.Key).sort(), ["desktop-thumb.avif", "desktop.avif", "phone-thumb.avif", "phone.avif"].map((f) => `0123456789abcdef/old1/${f}`));
  assert.ok(sent.indexOf(del) > sent.indexOf(puts.at(-1)), "the old version goes only after the new one is up");

  sent.length = 0;
  await storeVersion({ send, commands, bucket: "b", shotKey: "0123456789abcdef", v: "new1", prevV: undefined, files });
  assert.equal(sent.some((c) => c.name === "delete"), false, "nothing to delete without an older version");
  await assert.rejects(storeVersion({ send, commands, bucket: "b", shotKey: "private/grades/x", v: "1", files }), /not a shot key/);

  sent.length = 0;
  assert.equal(await deleteAllShots({ send, commands, bucket: "b", shotKey: "0123456789abcdef" }), 2);
  assert.equal(sent[0].input.Prefix, "0123456789abcdef/");
  await assert.rejects(deleteAllShots({ send, commands, bucket: "b", shotKey: "private" }), /not a shot key/);

  assert.equal(legacyFramesOn({}), true, "the old frames stay on until switched off");
  assert.equal(legacyFramesOn({ CAPTURE_LEGACY_FRAMES: "false" }), false);
  assert.deepEqual([...SERVE_FILES], ["hero.jpg", "mobile.jpg"]);
  assert.equal(contentTypeOf("desktop.avif"), "image/avif");
});

test("backfill queue: never tried first, retries a week apart, three tries at most, listed live sites only", async () => {
  process.env.LOCAL_DB_FILE = path.join(tmp, "backfill.db");
  const db = pipelineDb(tmp);
  await ensureRosterSchema(db);
  const now = Date.parse("2026-11-13T12:00:00Z");
  const done = { v: "abc", at: "2026-11-01T00:00:00Z", desktop: { width: 1440, height: 3000, bytes: 100 }, phone: { width: 390, height: 5000, bytes: 90 } };
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

  assert.equal(nextTries(null), 1);
  assert.equal(nextTries({ at: "x" }), 2, "a try by the capture counts as one");
  assert.equal(nextTries(failedOld), 2);
  const fp = { ...done, at: "2026-11-13T12:00:00Z" };
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

test("the Worker serves the old frames as before and never the tall images (they have their own domain)", async () => {
  const stored = new Map([
    ["0123456789abcdef/k3x9/desktop.avif", "D"],
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
  let res = await at("/shots/0123456789abcdef/hero.jpg?v=t1abc")();
  assert.deepEqual([res.status, res.headers.get("content-type"), res.headers.get("cache-control")], [200, "image/jpeg", "public, max-age=31536000, immutable"]);
  assert.equal(await res.text(), "H");
  res = await at("/shots/0123456789abcdef/mobile.jpg")();
  assert.deepEqual([res.status, res.headers.get("cache-control")], [404, "public, max-age=300"]);
  res = await at("/shots/0123456789abcdef/hero.jpg")();
  assert.equal(res.headers.get("cache-control"), "public, max-age=86400", "unversioned: a day");
  for (const p of [
    "/shots/0123456789abcdef/k3x9/desktop.avif",
    "/shots/0123456789abcdef/full.jpg",
    "/shots/0123456789abcdef/full-desktop.webp",
    "/shots/private/grades/x/hero.jpg",
    "/shots/0123456789abcdef/../hero.jpg",
  ]) {
    assert.equal(at(p), null, `${p} is not served here`);
  }
  assert.deepEqual(Object.keys(SHOT_FILES).sort(), [...SERVE_FILES].sort(), "the Worker serves the old frames the capture stores");
});

test("no images bucket yet: nothing stored and no version recorded, so the backfill fills in later", () => {
  assert.equal(imagesBucket({}), null);
  assert.equal(imagesBucket({ R2_IMAGES_BUCKET: " " }), null);
  assert.equal(imagesBucket({ R2_IMAGES_BUCKET: "portfolio-rank-images" }), "portfolio-rank-images");
  const fp = notStored({ v: "k3x9", at: "x", desktop: { width: 1, height: 1, bytes: 1 }, phone: { width: 1, height: 1, bytes: 1 } });
  assert.equal(fp.v, undefined);
  assert.equal(fp.notStored, true);
  assert.equal(fullPageComplete(fp), false, "stays due for the backfill");
  assert.equal(fullPageFrames("https://images.example/k", fp), null, "never linked");
});

test("preview URLs: versioned files, thumbnails and the top's height; only with both views; the switch is off by default", () => {
  const fp = { v: "k3x9", at: "2026-11-13T10:00:00Z", desktop: { width: 1440, height: 4000, cropped: true, bytes: 5 }, phone: { width: 390, height: 600, bytes: 4 } };
  assert.deepEqual(fullPageFrames("https://images.example/0123456789abcdef?v=old", fp), {
    desktop: { src: "https://images.example/0123456789abcdef/k3x9/desktop.avif", thumb: "https://images.example/0123456789abcdef/k3x9/desktop-thumb.avif", thumbWidth: 480, width: 1440, height: 4000, topHeight: 900, cropped: true },
    phone: { src: "https://images.example/0123456789abcdef/k3x9/phone.avif", thumb: "https://images.example/0123456789abcdef/k3x9/phone-thumb.avif", thumbWidth: 240, width: 390, height: 600, topHeight: 600, cropped: false },
  });
  assert.equal(fullPageFrames("/shots/k", { ...fp, phone: { error: "timeout" } }), null);
  assert.equal(fullPageFrames("/shots/k", { ...fp, v: undefined }), null, "no version, nothing stored");
  assert.equal(fullPageFrames("/shots/k", null), null);
  assert.equal(fullPagePreviewEnabled({}), false);
  assert.equal(fullPagePreviewEnabled({ FULLPAGE_PREVIEW_ENABLED: "false" }), false);
  assert.equal(fullPagePreviewEnabled({ FULLPAGE_PREVIEW_ENABLED: "true" }), true);
  const wrangler = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  const values = [...wrangler.matchAll(/"FULLPAGE_PREVIEW_ENABLED":\s*"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ["false", "false"], "off in production and on staging");
});
