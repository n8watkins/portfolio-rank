// The nightly capture (pipeline/capture.mjs captureSite) never stores an
// error page as the site, end to end in headless Chromium against local
// pages with a throwaway database:
//   - the main document's HTTP status decides (capture-blocked.mjs
//     httpVerdict): a firewall's 403 is a bot wall for the owner's review, a
//     503 is a failed capture with a retry, and a 429 on a refresh keeps the
//     good capture;
//   - a parked page drawn by script is parked, not live;
//   - the phone view is judged too: a gate only phones see stores nothing;
//   - a page whose main thread hangs after load is cut off at the site's time
//     limit, recorded as a failed capture with a retry, and its browser
//     context is closed;
//   - a failed refresh waits out a backoff in the refresh queue, and the next
//     good capture clears it;
//   - the old image version is deleted only after the row points at the new
//     one, and a capture that fails after uploading leaves the row's images.
// Every outbound link points at .invalid hosts; the storage bucket is a stand-in.
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
import { ACTIVE, dueForCapture, ensureRosterSchema } from "../pipeline/roster.mjs";
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
const E503 = `<!doctype html><title>503 Service Unavailable</title><body><h1>Service Unavailable</h1><p>The server is temporarily unable to service your request due to maintenance downtime or capacity problems. Please try again later.</p><a href="https://host.invalid/status">Status</a></body>`;

const pages = {
  // Parked, drawn by script: the plain pre-check sees no phrase.
  "/parked": `<!doctype html><title>Loading</title><body><div id=a></div><script>
    setTimeout(()=>{document.title="janedoe.dev";document.getElementById("a").innerHTML='<h1>janedoe.dev</h1><p>This domain is for sale. Buy this domain today.</p><p><a href="https://registrar.invalid/buy">Make an offer</a></p>'},300)</script></body>`,
  // The site on a desktop; on a phone a gate whose button does nothing.
  "/phonegate": `<!doctype html><title>Jane Doe</title><body style="margin:0"><script>
    if (innerWidth < 500) document.write('<div style="height:100vh;background:#000;color:#fff;display:grid;place-items:center"><button style="font-size:24px">CLICK TO ENTER</button></div>');
    else document.write(${JSON.stringify(SITE)});</script></body>`,
  "/site": SITE,
  // The main thread blocks for good a few seconds after load.
  "/hang": `<!doctype html><title>Jane Doe</title><body><h1>Jane Doe</h1><p>${"I build things for the web and write about them here. ".repeat(10)}</p><a href="https://code.invalid/jane">GitHub</a>
    <script>setTimeout(()=>{for(;;){}},2500)</script></body>`,
};

let flakyDown = true;
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

before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    if (req.url === "/cf1020") return res.writeHead(403, html).end(CF1020);
    if (req.url === "/ratelimit") return res.writeHead(429, html).end(CF1015);
    if (req.url === "/e503") return res.writeHead(503, html).end(E503);
    if (req.url === "/flaky") return flakyDown ? res.writeHead(503, html).end(E503) : res.writeHead(200, html).end(SITE);
    res.writeHead(pages[req.url] ? 200 : 404, html).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-errors-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  for (const p of ["/ratelimit", "/flaky"]) await seedGood(p);
  browser = await chromium.launch();
  const run = async (p, opts = {}) => {
    results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root, ...opts });
  };
  await Promise.all([run("/cf1020"), run("/e503"), run("/parked"), run("/phonegate"), run("/ratelimit", { refresh: true }), run("/flaky", { refresh: true })]);
});

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
});

test("a parked page drawn by script is parked, not live", async () => {
  assert.equal(results["/parked"], 'parked (parking phrase: "buy this domain")');
  const row = await rowOf("/parked");
  assert.equal(row.status, "parked");
  assert.equal(row.page_text, null);
  assert.equal(captured("/parked"), false);
});

test("a gate shown only on the phone view stores nothing", async () => {
  assert.equal(results["/phonegate"], "blocked (still a gate or loader after the click-through (phone view))");
  const row = await rowOf("/phonegate");
  assert.equal(row.status, "error");
  assert.equal(row.reason, `${BLOCKED_PREFIX}still a gate or loader after the click-through (phone view)`);
  assert.equal(row.page_text, null);
  assert.equal(captured("/phonegate"), false, "neither hero.jpg nor mobile.jpg written");
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

test("a page that hangs after load is cut off at the time limit, its context closed, and retried later", async () => {
  const b = await chromium.launch();
  try {
    const t0 = Date.now();
    const result = await captureSite(b, { url: url("/hang"), name: "Jane Doe" }, { db, s3: null, root, limitMs: 20000 });
    const s = (Date.now() - t0) / 1000;
    assert.equal(result, "error (capture timed out after 20s)");
    assert.ok(s < 45, `returned in ${s}s`);
    assert.equal(b.contexts().length, 0, "the hung page's context is closed");
    const row = await rowOf("/hang");
    assert.equal(row.status, "error");
    assert.equal(row.reason, "capture timed out after 20s");
    assert.equal(Number(row.capture_attempts), 1);
    assert.deepEqual(await dueForCapture(db, [{ url: url("/hang") }]), [], "not due again tonight");
    assert.equal(captured("/hang"), false);
    // The browser still works for the next site.
    const next = await captureSite(b, { url: url("/site"), name: "Jane Doe" }, { db, s3: null, root });
    assert.match(next, /^live/, next);
  } finally {
    await b.close();
  }
});

/** A stand-in bucket: logs every write, reads the row's image version at each delete, and can fail one upload. */
function fakeBucket({ failKey = null } = {}) {
  const log = [];
  return {
    log,
    send: async (cmd) => {
      const name = cmd.constructor.name;
      const keys = cmd.input.Key ? [cmd.input.Key] : (cmd.input.Delete?.Objects ?? []).map((o) => o.Key);
      const rowV = (await db.execute({ sql: "SELECT json_extract(meta, '$.fullPage.v') AS v FROM portfolios WHERE url = ?", args: [url("/site")] })).rows[0]?.v ?? null;
      log.push({ name, keys, rowV });
      if (failKey && name === "PutObjectCommand" && failKey.test(cmd.input.Key)) throw new Error("R2 503 SlowDown (stand-in)");
      return {};
    },
  };
}

test("images: the old version is deleted only after the row points at the new one; a failed upload leaves the row's images", async () => {
  const prev = process.env.R2_IMAGES_BUCKET;
  process.env.R2_IMAGES_BUCKET = "test-images";
  try {
    // A stored capture whose images (version "oldv") differ from what the page shows now.
    await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url("/site")] });
    await seedGood("/site", { motion: false, fullPage: { v: "oldv", textHash: "x", desktop: { bytes: 1 }, phone: { bytes: 1 } } });

    // The last upload (the old frames' hero.jpg) fails: the row and its images stay as they were.
    const failing = fakeBucket({ failKey: /hero\.jpg$/ });
    const r1 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: failing, root });
    assert.match(r1, /^error \(R2 503/, r1);
    const deletes1 = failing.log.filter((l) => l.name === "DeleteObjectsCommand");
    assert.ok(!deletes1.some((d) => d.keys.some((k) => k.includes("/oldv/"))), "the row's images are not deleted");
    assert.equal((await rowOf("/site")).page_text, OLD_TEXT);
    assert.equal(JSON.parse(String((await rowOf("/site")).meta)).fullPage.v, "oldv");

    // A good capture: the old version goes after the row names the new one.
    const ok = fakeBucket();
    const r2 = await captureSite(browser, { url: url("/site"), name: "Jane Doe" }, { refresh: true, db, s3: ok, root });
    assert.match(r2, /^live/, r2);
    const newV = JSON.parse(String((await rowOf("/site")).meta)).fullPage.v;
    assert.notEqual(newV, "oldv");
    const del = ok.log.find((l) => l.name === "DeleteObjectsCommand");
    assert.ok(del, "the old version is deleted");
    assert.ok(del.keys.every((k) => k.includes("/oldv/")));
    assert.equal(del.rowV, newV, "the row already pointed at the new version when the old one was deleted");
  } finally {
    if (prev === undefined) delete process.env.R2_IMAGES_BUCKET;
    else process.env.R2_IMAGES_BUCKET = prev;
  }
});
