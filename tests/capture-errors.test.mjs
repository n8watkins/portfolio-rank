// The nightly capture (pipeline/capture.mjs captureSite) never stores an
// error page as the site, end to end in headless Chromium against local
// pages with a throwaway database:
//   - the main document's HTTP status decides (capture-blocked.mjs
//     httpVerdict): a firewall's 403 is a bot wall for the owner's review, a
//     503 is a failed capture with a retry decided before the waits and the
//     scroll-through, and a 429 on a refresh keeps the good capture;
//   - a parked page drawn by script is parked, not live, also when the home
//     page only sends the browser to it; a language redirect is the site;
//   - the desktop view decides: a gate only phones see is a note in the
//     meta, and an error status on a reload the phone width caused is a
//     missing phone view, never a failed capture;
//   - a forced re-capture whose pre-check fails keeps a captured site live;
//   - the page text stored is the text judged;
//   - a failed refresh waits out a backoff in the refresh queue, and the next
//     good capture clears it.
// The time limit and the storage order are in capture-limits.test.mjs.
// Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { captureSite, keyOf } from "../pipeline/capture.mjs";
import { BLOCKED_PREFIX, BOT_WALL } from "../pipeline/capture-blocked.mjs";
import { ACTIVE, ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema, screenshotsDue } from "../lib/freshness.mjs";

const SITE = `<!doctype html><title>Jane Doe</title><body style="font:18px system-ui;max-width:800px;margin:40px auto"><h1>Jane Doe</h1><h2>Backend engineer</h2>
<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(6)}</p>
<p><a href="https://code.invalid/jane/ledger">Ledger</a> <a href="https://social.invalid/jane">Profile</a></p></body>`;
const CF1020 = `<!doctype html><title>Access denied | example.dev used Cloudflare to restrict access</title><body style="font:16px system-ui;padding:40px">
<h1>Error 1020</h1><h2>Access denied</h2><p>What happened?</p><p>This website is using a security service to protect itself from online attacks.
The action you just performed triggered the security solution.</p><p>Ray ID: 8f2a1b3c4d5e6f70 &bull; Performance &amp; security by <a href="https://www.cloudflare.invalid/5xx-error-landing">Cloudflare</a></p></body>`;
const CF1015 = `<!doctype html><title>Access denied | example.dev used Cloudflare to restrict access</title><body style="font:16px system-ui;padding:40px">
<h1>Error 1015</h1><h2>You are being rate limited</h2><p>What happened?</p><p>The owner of this website (example.dev) has banned you temporarily from accessing this website.</p>
<p>Ray ID: 8f2a1b3c4d5e6f70 &bull; Performance &amp; security by <a href="https://www.cloudflare.invalid/5xx-error-landing">Cloudflare</a></p></body>`;
// A lazy image far down the page: only the scroll-through would ask for it.
const E503 = `<!doctype html><title>503 Service Unavailable</title><body><h1>Service Unavailable</h1><p>The server is temporarily unable to service your request due to maintenance downtime or capacity problems. Please try again later.</p><a href="https://host.invalid/status">Status</a>
<div style="height:6000px"></div><img loading=lazy src="/lazy-503.png" width=40 height=40></body>`;

const pages = {
  // Parked, drawn by script: the plain pre-check sees no phrase.
  "/parked": `<!doctype html><title>Loading</title><body><div id=a></div><script>
    setTimeout(()=>{document.title="janedoe.dev";document.getElementById("a").innerHTML='<h1>janedoe.dev</h1><p>This domain is for sale. Buy this domain today.</p><p><a href="https://registrar.invalid/buy">Make an offer</a></p>'},300)</script></body>`,
  // The site on a desktop; at phone width only a gate whose button does nothing.
  "/phonegate": SITE.replace("<body ", `<body class=site `).replace(
    "</body>",
    `<div class=gate style="display:none;height:100vh;background:#000;color:#fff;place-items:center"><button style="font-size:24px">CLICK TO ENTER</button></div>
    <style>@media (max-width: 500px) { body.site > :not(.gate) { display: none } .gate { display: grid !important } }</style></body>`
  ),
  // The desktop view leaves a cookie and reloads the page when the window narrows; that load (which sends the cookie) gets a 503.
  "/phone503": SITE.replace("</body>", `<script>document.cookie="seen=1; path=/";addEventListener("resize",()=>{if(innerWidth<500)location.reload()})</script></body>`),
  // A preloader line until the page is scrolled; the scroll-through shows the site.
  "/scrollreveal": `<!doctype html><title>Jane Doe</title><body style="font:18px system-ui;margin:0"><p>Loading the portfolio of Jane Doe, please wait while it gets ready: 87%</p><div style="height:3000px"></div>
    <script>addEventListener("scroll",()=>{if(!window.done){window.done=1;document.body.innerHTML=${JSON.stringify(SITE)}+'<div style="height:2000px"></div>'}})</script></body>`,
  // A home page that only sends the browser on, by an address built at run time (the plain pre-check
  // cannot read it), to a parking lander drawn by script (GoDaddy's, as nic-nguyen.com showed on 2026-11-23).
  "/built-redirect": `<!doctype html><html><head><script>window.onload=function(){window.location.href="/"+"lander"}</script></head></html>`,
  "/lander": `<!doctype html><html><head><title></title></head><body><div id=root></div><script>
    setTimeout(()=>{document.getElementById("root").innerHTML='<h1>janedoe.dev</h1><p>has expired and is parked free, courtesy of GoDaddy.com.</p><p><a href="https://registrar.invalid/buy">Get This Domain</a></p><p>Related Search Topics</p><ul><li>Real Estate</li><li>Cheap Airfare</li></ul>'},300)</script></body></html>`,
  // A real site behind a language redirect made by script: captured as the site.
  "/to-en": `<!doctype html><html><head><script>location.replace("/en/")</script></head><body></body></html>`,
  "/en/": SITE,
};

let flakyDown = true;
let lazyRequests = 0;
let phoneLazyRequests = 0;
let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;
const OLD_TEXT = "Old good page text of the portfolio";
const OLD_AT = "2026-07-01 00:00:00";

async function seedGood(p, meta = { motion: false, fullPage: { v: "oldv" } }) {
  await db.execute({
    sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', ?, ?, ?, '{}', ?, ?)",
    args: [url(p), keyOf(url(p)), JSON.stringify(meta), OLD_TEXT, OLD_AT, OLD_AT],
  });
}

// Eleven captures side by side on a machine that runs other test files too: the
// hook gets far more than the runner's default per-test timeout.
before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    if (req.url === "/cf1020") return res.writeHead(403, html).end(CF1020);
    if (req.url === "/ratelimit") return res.writeHead(429, html).end(CF1015);
    if (req.url === "/e503") return res.writeHead(503, html).end(E503);
    if (req.url === "/flaky") return flakyDown ? res.writeHead(503, html).end(E503) : res.writeHead(200, html).end(SITE);
    if (req.url === "/e502") return res.writeHead(502, html).end("<h1>Bad Gateway</h1>");
    if (req.url === "/lazy-503.png") {
      // Only /e503's own page counts (the other 503 pages here share its HTML).
      if (/\/e503$/.test(req.headers.referer ?? "")) lazyRequests++;
      if (/\/phone503$/.test(req.headers.referer ?? "")) phoneLazyRequests++;
      return res.writeHead(404).end();
    }
    if (req.url === "/phone503" && /seen=1/.test(req.headers.cookie ?? "")) return res.writeHead(503, html).end(E503);
    res.writeHead(pages[req.url] ? 200 : 404, html).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-errors-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  for (const p of ["/ratelimit", "/flaky", "/e502"]) await seedGood(p);
  browser = await chromium.launch();
  const run = async (p, opts = {}) => {
    results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root, ...opts });
  };
  await Promise.all([
    run("/cf1020"),
    run("/e503"),
    run("/parked"),
    run("/phonegate"),
    run("/phone503"),
    run("/scrollreveal"),
    run("/ratelimit", { refresh: true }),
    run("/flaky", { refresh: true }),
    // A forced re-capture (not a refresh) of a captured site whose plain fetch now answers 502.
    run("/e502"),
    run("/built-redirect"),
    run("/to-en"),
  ]);
}, { timeout: 600000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const captured = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p))));
const daysUntil = (iso) => (Date.parse(String(iso)) - Date.now()) / 86400000;

test("a firewall's 403 page is a bot wall for the owner's review, never stored", async () => {
  assert.equal(results["/cf1020"], `blocked (${BOT_WALL})`);
  const row = await rowOf("/cf1020");
  assert.equal(row.status, "error");
  assert.equal(row.reason, `${BLOCKED_PREFIX}${BOT_WALL}`);
  assert.equal(Number(row.needs_review), 1);
  assert.equal(row.page_text, null);
  assert.equal(row.shot_key, null);
  assert.equal(captured("/cf1020"), false);
});

test("a 503 page is a failed capture with a retry, not the site", async () => {
  assert.equal(results["/e503"], "error (HTTP 503)");
  const row = await rowOf("/e503");
  assert.equal(row.status, "error");
  assert.equal(row.reason, "HTTP 503");
  assert.equal(Number(row.needs_review), 0);
  assert.equal(row.page_text, null);
  const days = daysUntil(row.retry_at);
  assert.ok(days > 0.9 && days < 1.1, `retried in a day, got ${days}`);
  assert.equal(captured("/e503"), false);
  // Decided before the waits and the scroll-through: the lazy image far down the page was never asked for.
  assert.equal(lazyRequests, 0, "the error page was not scrolled through");
});

test("a forced re-capture of a captured site whose plain fetch answers 502 keeps the site live", async () => {
  assert.equal(results["/e502"], "error (HTTP 502); the existing capture is kept");
  const row = await rowOf("/e502");
  assert.equal(row.status, "live");
  assert.equal(row.reason, "");
  assert.equal(Number(row.capture_attempts), 0);
  assert.equal(row.retry_at, null);
  assert.equal(row.page_text, OLD_TEXT);
});

test("the page text stored is the text judged after the scroll-through, never the preloader's", async () => {
  assert.match(results["/scrollreveal"], /^live/, results["/scrollreveal"]);
  const text = String((await rowOf("/scrollreveal")).page_text);
  assert.match(text, /Backend engineer/);
  assert.doesNotMatch(text, /Loading the portfolio|87%/);
});

test("a home page that sends the browser to a parking lander is parked by the capture's own judgement; a language redirect is the site", async () => {
  assert.equal(results["/built-redirect"], 'parked (parking phrase: "has expired and is parked")');
  const row = await rowOf("/built-redirect");
  assert.deepEqual([row.status, row.page_text, row.shot_key], ["parked", null, null]);
  assert.equal(captured("/built-redirect"), false);
  assert.match(results["/to-en"], /^live/, results["/to-en"]);
  assert.match(String((await rowOf("/to-en")).page_text), /Backend engineer/);
});

test("a parked page drawn by script is parked, not live", async () => {
  assert.equal(results["/parked"], 'parked (parking phrase: "buy this domain")');
  const row = await rowOf("/parked");
  assert.equal(row.status, "parked");
  assert.equal(row.page_text, null);
  assert.equal(captured("/parked"), false);
});

test("a gate shown only on the phone view does not fail a site the desktop view shows; the meta notes it", async () => {
  assert.match(results["/phonegate"], /^live/, results["/phonegate"]);
  const row = await rowOf("/phonegate");
  assert.equal(row.status, "live");
  const meta = JSON.parse(String(row.meta));
  assert.equal(meta.phoneBlocked, "still a gate or loader after the click-through");
  assert.match(String(row.page_text), /Backend engineer/);
});

test("an error status on a reload the phone view caused never fails the site: the phone view is recorded as missing", async () => {
  assert.match(results["/phone503"], /^live/, results["/phone503"]);
  const row = await rowOf("/phone503");
  assert.deepEqual([row.status, row.reason, Number(row.capture_attempts ?? 0)], ["live", "", 0]);
  assert.match(String(row.page_text), /Backend engineer/, "the desktop view is stored");
  assert.equal(JSON.parse(String(row.meta)).phoneMissing, "HTTP 503");
  assert.equal(captured("/phone503"), true);
  assert.equal(phoneLazyRequests, 0, "the error page was not scrolled through");
});

test("a 429 rate-limit page on a refresh keeps the good capture and waits out a backoff", async () => {
  assert.equal(results["/ratelimit"], "error (HTTP 429 (rate limited)); the existing capture is kept");
  const row = await rowOf("/ratelimit");
  assert.equal(row.status, "live");
  assert.equal(row.page_text, OLD_TEXT, "the page text is not replaced");
  assert.equal(row.captured_at, OLD_AT, "captured_at is not renewed");
  assert.equal(Number(row.capture_attempts), 0, "the site is not marked failed");
  assert.equal(captured("/ratelimit"), false);
  const backoff = (await db.execute({ sql: "SELECT attempts, retry_at FROM refresh_failures WHERE url = ?", args: [url("/ratelimit")] })).rows[0];
  assert.equal(Number(backoff.attempts), 1);
  const days = (Number(backoff.retry_at) - Date.now()) / 86400000;
  assert.ok(days > 0.9 && days < 1.1, `retried in a day, got ${days}`);
});

test("a failed refresh leaves the head of the refresh queue until its backoff ends; a good capture clears it", async () => {
  assert.equal(results["/flaky"], "error (HTTP 503); the existing capture is kept");
  assert.equal((await rowOf("/flaky")).captured_at, OLD_AT);
  // Both 90-day-old captures are due for a refresh, but the two that just failed wait.
  const due = await screenshotsDue(db, { limit: 10, active: ACTIVE });
  assert.ok(!due.includes(url("/flaky")) && !due.includes(url("/ratelimit")), `not due tonight: ${due}`);
  const later = await screenshotsDue(db, { now: Date.now() + 2 * 86400000, limit: 10, active: ACTIVE });
  assert.ok(later.includes(url("/flaky")), "due again once the backoff ends");
  // The site is back: the refresh stores it and the backoff is gone.
  flakyDown = false;
  const result = await captureSite(browser, { url: url("/flaky"), name: "Jane Doe" }, { refresh: true, db, s3: null, root });
  assert.match(result, /^live/, result);
  assert.notEqual((await rowOf("/flaky")).captured_at, OLD_AT);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM refresh_failures WHERE url = ?", args: [url("/flaky")] })).rows[0].n, 0);
});

