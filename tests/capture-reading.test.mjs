// What the nightly capture (pipeline/capture.mjs captureSite) reads, judges
// and stores, end to end in headless Chromium against local pages:
//   - the page text is read as a visitor sees it: fixed and sticky bars that
//     the scroll-through's stitching hides are shown again first, so a site
//     whose words sit in a fixed header over a canvas is a site, and a site
//     with a sticky navigation stores the same page text as before this
//     change (the reading of the page at the top, without scrolling);
//   - a non-interactive challenge (403 with cf-mitigated: challenge) that
//     reloads into the site a few seconds later is captured as the site;
//   - a single-page app served from a copied 404.html that mentions a "rate
//     limiter" goes to the owner's review, not "rate limited" and not a bot wall;
//   - a short portfolio whose contact form asks to "complete the captcha" is
//     a site, not a bot wall.
// Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { captureSite } from "../pipeline/capture.mjs";
import { OWNER_REVIEW_PREFIX, isBlockedReason, isBotWallReason } from "../pipeline/capture-blocked.mjs";
import { UA } from "../pipeline/gate.mjs";
import { normalizePageText } from "../pipeline/rubric.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";

const ABOUT = "I build payment systems and developer tools that stay up at three in the morning. ";
const STICKY = `<!doctype html><title>Jane Doe</title><body style="margin:0;font:18px system-ui">
<nav style="position:sticky;top:0;background:#fff;padding:12px;border-bottom:1px solid #ddd">Jane Doe <a href="/work">Work</a> <a href="/about">About</a> <a href="mailto:jane@example.invalid">Contact</a></nav>
<main style="max-width:800px;margin:40px auto"><h1>Backend engineer</h1>${`<p>${ABOUT.repeat(4)}</p>`.repeat(12)}
<p><a href="https://code.invalid/jane">GitHub</a></p></main>
<a href="mailto:jane@example.invalid" style="position:fixed;right:16px;bottom:16px;background:#111;color:#fff;padding:10px">Hire me</a></body>`;

const pages = {
  // A dark full-screen canvas; every word and link sits in a fixed header over it.
  "/canvasheader": `<!doctype html><title>Jane Doe</title><body style="margin:0;background:#000">
    <header style="position:fixed;top:0;left:0;right:0;padding:16px;color:#fff;font:20px system-ui;z-index:2">Jane Doe - creative developer <a style="color:#fff" href="https://code.invalid/jane">GitHub</a> <a style="color:#fff" href="https://social.invalid/jane">LinkedIn</a></header>
    <canvas id=c width=1440 height=900 style="display:block;width:100vw;height:100vh"></canvas><script>const x=c.getContext("2d");x.fillStyle="#000";x.fillRect(0,0,1440,900)</script></body>`,
  "/sticky": STICKY,
  // A short one-page portfolio whose contact form uses a captcha.
  "/captchaform": `<!doctype html><title>Ana Ruiz</title><body style="font:18px system-ui;padding:40px"><h1>Ana Ruiz</h1><p>Product designer in Madrid.</p>
    <p><a href="https://code.invalid/ana">GitHub</a> <a href="mailto:ana@example.invalid">Email</a></p>
    <form><p>Write to me: complete the captcha below and press send.</p><textarea></textarea><div class="g-recaptcha" style="width:300px;height:76px;background:#eee"></div><button>Send</button></form></body>`,
};
const CHALLENGE = `<!doctype html><title>Just a moment...</title><body style="font:18px system-ui;padding:40px"><h1>example.dev</h1><p>Verifying you are human. This may take a few seconds.</p>
  <script>setTimeout(()=>{document.cookie="cleared=1; path=/";location.reload()},9000)</script></body>`;
const SPA = `<!doctype html><title>Jane Doe</title><body style="font:18px system-ui;max-width:800px;margin:40px auto"><h1>Jane Doe</h1>
  <p>Backend engineer. I built a rate limiter for the payments API, and a separate limited-edition print shop.</p><p>${ABOUT.repeat(14)}</p>
  <p><a href="https://code.invalid/jane">GitHub</a> <a href="https://social.invalid/jane">LinkedIn</a></p></body>`;

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;

before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    const navigation = req.headers["sec-fetch-mode"] === "navigate";
    if (req.url === "/challenge") {
      if (/cleared=1/.test(req.headers.cookie ?? "")) return res.writeHead(200, html).end(SPA.replace(/rate limiter|limited-edition/g, "service"));
      return res.writeHead(403, { ...html, "cf-mitigated": "challenge" }).end(CHALLENGE);
    }
    // The plain pre-check gets the app; the browser's navigation gets it from a copied 404.html.
    if (req.url === "/spa404") return res.writeHead(navigation ? 404 : 200, html).end(SPA);
    res.writeHead(pages[req.url] ? 200 : 404, html).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-reading-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  browser = await chromium.launch();
  await Promise.all(
    ["/canvasheader", "/sticky", "/captchaform", "/challenge", "/spa404"].map(async (p) => {
      results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root });
    })
  );
}, { timeout: 600000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];

test("a site whose words sit in a fixed header over a dark canvas is captured as live, with that text", async () => {
  assert.match(results["/canvasheader"], /^live/, results["/canvasheader"]);
  const row = await rowOf("/canvasheader");
  assert.equal(row.status, "live");
  assert.match(String(row.page_text), /Jane Doe - creative developer/);
});

test("a site with a sticky navigation stores its full page text, the same as the reading at the top of the page", async () => {
  assert.match(results["/sticky"], /^live/, results["/sticky"]);
  const stored = String((await rowOf("/sticky")).page_text);
  assert.match(stored, /Jane Doe Work About Contact/, "the sticky navigation is in the page text");
  assert.match(stored, /Hire me/, "the floating contact button is in the page text");
  // The page as the capture read it before this change: at the top, nothing scrolled or hidden.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  try {
    const page = await ctx.newPage();
    await page.goto(url("/sticky"), { waitUntil: "load" });
    const top = await page.evaluate(() => document.body.innerText);
    assert.equal(stored, normalizePageText(top), "same page text, so the same text hash and no new image version");
  } finally {
    await ctx.close();
  }
});

test("a challenge that answers 403 and reloads into the site a few seconds later is captured as the site", async () => {
  assert.match(results["/challenge"], /^live/, results["/challenge"]);
  const row = await rowOf("/challenge");
  assert.equal(row.status, "live");
  assert.equal(Number(row.needs_review), 0);
  assert.doesNotMatch(String(row.page_text), /Verifying you are human/);
});

test("a single-page app served from a copied 404.html that mentions a rate limiter goes to the owner's review", async () => {
  const row = await rowOf("/spa404");
  assert.equal(row.status, "error");
  assert.ok(String(row.reason).startsWith(OWNER_REVIEW_PREFIX), row.reason);
  assert.match(String(row.reason), /HTTP 404/);
  assert.doesNotMatch(String(row.reason), /rate limited/);
  assert.equal(isBotWallReason(row.reason), false, "not filed as a bot wall");
  assert.equal(isBlockedReason(row.reason), false, "not a blocked reason the health check would fail");
  assert.equal(Number(row.needs_review), 1);
});

test("a short portfolio whose contact form asks to complete the captcha is a site, not a bot wall", async () => {
  assert.match(results["/captchaform"], /^live/, results["/captchaform"]);
  assert.equal((await rowOf("/captchaform")).status, "live");
});
