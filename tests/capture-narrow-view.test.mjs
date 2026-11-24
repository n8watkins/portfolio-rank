// The capture's narrow view (pipeline/capture.mjs captureSite), end to end in
// headless Chromium against local pages with a throwaway database and no
// storage bucket:
//   - the narrow view (390 x 844) is the page already loaded, resized: the
//     site gets one document load from the browser, not two;
//   - a site whose protection challenges every repeat visit (as Cloudflare
//     did on 28 of the 30 sites whose refresh failed "only on our second
//     visit at phone size") is captured with its desktop view; a first
//     capture and a refresh alike;
//   - a site that reloads itself when the window narrows, into that
//     challenge, keeps its desktop capture: the narrow view is recorded as
//     missing in the meta, with its reason, and is never a failed capture
//     or a refresh failure;
//   - a real narrow layout is still measured: sideways overflow at 390 and
//     projects that only the narrow layout shows.
// Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import sharp from "sharp";
import { captureSite, keyOf } from "../pipeline/capture.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";
import { ensureCaptureProblemSchema } from "../lib/capture-problems.mjs";

const SITE = `<main style="font:18px system-ui;max-width:800px;margin:40px auto;padding:0 16px">
<h1>Jane Doe</h1><h2>Backend engineer</h2>
<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(6)}</p>
<ul><li><a href="https://code.invalid/jane/ledger">Ledger</a>: a double-entry ledger in Go.</li></ul>
<p><a href="https://social.invalid/jane">Profile</a></p></main>`;

// Cloudflare's managed challenge, as it answers a visit it does not trust: 403, cf-mitigated: challenge.
const CHALLENGE = `<!doctype html><title>Just a moment...</title><body><h1>janedoe.dev</h1><p>Verifying you are human. This may take a few seconds.</p>
  <p>janedoe.dev needs to review the security of your connection before proceeding.</p><p>Ray ID: 8f2a1b3c4d5e6f70</p><p>Performance &amp; security by Cloudflare</p></body>`;

// The projects only a narrow layout shows, rendered by script when a media
// query matches (as React's useMediaQuery does), and a 600 px banner that
// only the narrow layout has, which makes it scroll sideways at 390.
const NARROW = `<!doctype html><title>Jane Doe</title><style>@media (max-width: 500px) { .banner { width: 600px } }</style>
  <body style="margin:0">${SITE}<div class=banner style="height:40px;background:#cde"></div><div id=narrow></div><script>
  const mq = matchMedia("(max-width: 500px)");
  const draw = () => { document.getElementById("narrow").innerHTML = mq.matches
    ? '<section id=projects><h2>Projects</h2><a href="https://one.invalid/">One</a> <a href="https://two.invalid/">Two</a> <a href="https://three.invalid/">Three</a></section>' : ""; };
  draw(); mq.addEventListener("change", draw);</script></body>`;

const pages = {
  "/once": `<!doctype html><title>Jane Doe</title><body>${SITE}</body>`,
  "/cf-repeat": `<!doctype html><title>Jane Doe</title><body>${SITE}</body>`,
  "/cf-repeat-refresh": `<!doctype html><title>Jane Doe</title><body>${SITE}</body>`,
  // Reloads itself when the window narrows (a layout chosen once at load); the reload meets the challenge.
  "/cf-reload": `<!doctype html><title>Jane Doe</title><body>${SITE}<script>addEventListener("resize",()=>{if(innerWidth<500)location.reload()})</script></body>`,
  "/cf-reload-refresh": `<!doctype html><title>Jane Doe</title><body>${SITE}<script>addEventListener("resize",()=>{if(innerWidth<500)location.reload()})</script></body>`,
  "/narrow": NARROW,
};
/** The sites that challenge every repeat visit from the browser. */
const REPEAT_CHALLENGED = new Set(["/cf-repeat", "/cf-repeat-refresh", "/cf-reload", "/cf-reload-refresh"]);

let server;
let browser;
let base;
let db;
let root;
const results = {};
/** The browser's document loads, per path (the plain pre-check sends no sec-fetch-mode). */
const loads = {};
const url = (p) => `${base}${p}`;
const OLD_TEXT = "Old good page text of the portfolio";
const OLD_AT = "2026-07-01 00:00:00";

before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    const navigation = req.headers["sec-fetch-mode"] === "navigate";
    if (navigation) loads[req.url] = (loads[req.url] ?? 0) + 1;
    if (navigation && REPEAT_CHALLENGED.has(req.url) && loads[req.url] >= 2) {
      return res.writeHead(403, { ...html, "cf-mitigated": "challenge" }).end(CHALLENGE);
    }
    res.writeHead(pages[req.url] ? 200 : 404, html).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-narrow-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  await ensureCaptureProblemSchema(db);
  for (const p of ["/cf-repeat-refresh", "/cf-reload-refresh"]) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Jane Doe', 'live', '', ?, ?, ?, '{}', ?, ?)",
      args: [url(p), keyOf(url(p)), JSON.stringify({ motion: false }), OLD_TEXT, OLD_AT, OLD_AT],
    });
  }
  browser = await chromium.launch();
  const run = async (p, opts = {}) => {
    results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root, ...opts });
  };
  // Three at a time: the machine is shared with other test files.
  await Promise.all([run("/once"), run("/cf-repeat"), run("/narrow")]);
  await Promise.all([run("/cf-repeat-refresh", { refresh: true }), run("/cf-reload"), run("/cf-reload-refresh", { refresh: true })]);
}, { timeout: 600000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const metaOf = async (p) => JSON.parse(String((await rowOf(p)).meta));
const fileOf = (p, f) => path.join(root, "captures", keyOf(url(p)), f);
const refreshFailure = async (p) => (await db.execute({ sql: "SELECT reason FROM refresh_failures WHERE url = ?", args: [url(p)] })).rows[0];

test("the narrow view is the loaded page resized: one document load, a 390 x 844 phone image", async () => {
  assert.match(results["/once"], /^live/, results["/once"]);
  assert.equal(loads["/once"], 1, "the browser loaded the page once");
  const meta = await metaOf("/once");
  assert.equal(meta.overflow390, false);
  assert.equal(meta.phoneMissing, undefined);
  assert.equal(meta.fullPage.phone.width, 390, "the tall phone image was made");
  assert.ok(meta.fullPage.phone.bytes > 0);
  const m = await sharp(fileOf("/once", "mobile.jpg")).metadata();
  assert.deepEqual([m.width, m.height], [390, 844]);
});

test("a site that challenges every repeat visit is captured from its one visit, first capture and refresh alike", async () => {
  assert.match(results["/cf-repeat"], /^live/, results["/cf-repeat"]);
  const row = await rowOf("/cf-repeat");
  assert.deepEqual([row.status, row.reason, Number(row.capture_attempts ?? 0), Number(row.needs_review ?? 0)], ["live", "", 0, 0]);
  assert.match(String(row.page_text), /Backend engineer/);
  assert.equal(loads["/cf-repeat"], 1, "no second visit for the challenge to answer");
  assert.equal((await metaOf("/cf-repeat")).fullPage.phone.width, 390);

  assert.match(results["/cf-repeat-refresh"], /^live/, results["/cf-repeat-refresh"]);
  const refreshed = await rowOf("/cf-repeat-refresh");
  assert.notEqual(refreshed.captured_at, OLD_AT, "the refresh stored its new capture");
  assert.equal(await refreshFailure("/cf-repeat-refresh"), undefined, "no refresh failure");
});

test("a narrow view that meets a bot check never discards a good desktop capture: it is recorded as missing", async () => {
  assert.match(results["/cf-reload"], /^live/, results["/cf-reload"]);
  const row = await rowOf("/cf-reload");
  assert.deepEqual([row.status, row.reason, Number(row.capture_attempts ?? 0), Number(row.needs_review ?? 0)], ["live", "", 0, 0]);
  assert.match(String(row.page_text), /Backend engineer/, "the desktop view's text is stored");
  assert.doesNotMatch(String(row.page_text), /Verifying you are human/);
  assert.equal(loads["/cf-reload"], 2, "the page's own reload was the only second load");
  const meta = await metaOf("/cf-reload");
  assert.match(String(meta.phoneMissing), /bot or security check/, JSON.stringify(meta.phoneMissing));
  assert.equal(meta.overflow390, null, "no overflow measured on a challenge page");
  // The desktop's tall image stands; the phone's is recorded as missing, never as an image of the challenge.
  assert.ok(meta.fullPage.desktop.bytes > 0);
  assert.equal(meta.fullPage.phone.bytes, undefined);
  assert.match(String(meta.fullPage.phone.missing), /bot or security check/);
  // A new site has no phone frame at all: its mobile.jpg is the desktop's first screen, so nothing shows a broken image.
  assert.deepEqual(fs.readFileSync(fileOf("/cf-reload", "mobile.jpg")), fs.readFileSync(fileOf("/cf-reload", "hero.jpg")));
  // Its facts are the desktop's alone.
  assert.deepEqual(JSON.parse(String(row.facts)).views, ["desktop"]);

  assert.match(results["/cf-reload-refresh"], /^live/, results["/cf-reload-refresh"]);
  assert.notEqual((await rowOf("/cf-reload-refresh")).captured_at, OLD_AT);
  assert.equal(await refreshFailure("/cf-reload-refresh"), undefined, "no refresh failure");
  assert.match(String((await metaOf("/cf-reload-refresh")).phoneMissing), /bot or security check/);
  // A site with a good capture keeps the phone frame it has: none is written over it.
  assert.equal(fs.existsSync(fileOf("/cf-reload-refresh", "mobile.jpg")), false);
});

test("a real narrow layout is still measured: sideways overflow at 390 and projects only shown at 390", async () => {
  assert.match(results["/narrow"], /^live/, results["/narrow"]);
  assert.equal(loads["/narrow"], 1);
  const meta = await metaOf("/narrow");
  assert.equal(meta.overflow390, true, "the 600 px banner of the narrow layout overflows");
  const facts = JSON.parse(String((await rowOf("/narrow")).facts));
  assert.deepEqual(facts.views, ["desktop", "phone"]);
  const fromPhone = facts.project_candidates.filter((c) => c.from === "phone").map((c) => c.url.replace(/\/$/, ""));
  assert.deepEqual(fromPhone.sort(), ["https://one.invalid", "https://three.invalid", "https://two.invalid"]);
  // The desktop's own links are still the desktop's.
  assert.ok(!facts.project_candidates.some((c) => c.from === "home" && /one\.invalid/.test(c.url)));
});
