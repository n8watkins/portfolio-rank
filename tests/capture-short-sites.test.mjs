// Short and unusual pages through the nightly capture (pipeline/capture.mjs
// captureSite), end to end in headless Chromium against local pages, judged
// by the blocked rules (pipeline/capture-blocked.mjs):
//   - real short portfolios are stored as live: the short home page of a
//     multi-page site, "start" in a sentence, a bio that says "not a robot",
//     Google's reCAPTCHA notice on a minimal page, "I'm not a robot" in a title;
//   - a canvas-only page (no text, no links) is never graded on its own: one
//     that drew something goes to the owner's review, a flat black one is
//     blocked as blank;
//   - real walls stay blocked: a gate word as a button's whole text, a nearly
//     empty "verify you are not a robot" page, and a 55-word interstitial
//     served with HTTP 200 ("Enter the characters you see below"), which on
//     a refresh never replaces the good capture.
// Every outbound link points at .invalid hosts, so nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { captureSite, keyOf } from "../pipeline/capture.mjs";
import { BLANK_FRAME, BLOCKED_PREFIX, BOT_WALL, MEDIA_REVIEW_REASON, isBlockedReason } from "../pipeline/capture-blocked.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";

const WAF = `<!doctype html><title>Example.com</title><body style="font:16px system-ui;padding:40px"><h4>Enter the characters you see below</h4>
<p>Sorry, we just need to make sure you're not a robot. For best results, please make sure your browser is accepting cookies.</p>
<form action="/errors/validateCaptcha"><p>Type the characters you see in this image:</p><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='70'%3E%3Ctext x='10' y='45' font-size='36'%3EXKCDQ%3C/text%3E%3C/svg%3E" width=200 height=70>
<input type=text name=field-keywords><button type=submit>Continue shopping</button></form>
<p><a href="/conditions">Conditions of Use</a> <a href="/privacy">Privacy Policy</a> &copy; 1996-2026, Example.com, Inc. or its affiliates</p></body>`;

const pages = {
  // Flutter web or three.js: the whole site drawn on a canvas, no DOM text or links.
  "/canvas": `<!doctype html><title>Jane Doe - Portfolio</title><body style="margin:0"><canvas id=c width=1440 height=900 style="display:block;width:100vw;height:100vh"></canvas><script>
    const x=c.getContext("2d");x.fillStyle="#123";x.fillRect(0,0,1440,900);x.fillStyle="#fff";x.font="80px sans-serif";x.fillText("Jane Doe - Creative Developer",120,300);x.font="30px sans-serif";x.fillText("Projects   About   Contact",120,400);</script></body>`,
  // A WebGL canvas that never rendered: full-screen black, no text.
  "/blackcanvas": `<!doctype html><title>Jane Doe</title><body style="margin:0;background:#000"><canvas id=c width=1440 height=900 style="display:block;width:100vw;height:100vh"></canvas><script>
    const x=c.getContext("2d");x.fillStyle="#000";x.fillRect(0,0,1440,900);</script></body>`,
  // A short home page: name, one sentence, its own navigation and a mailto link.
  "/shorthome": `<!doctype html><title>Sam Lee</title><body style="font:20px system-ui;padding:40px"><h1>Sam Lee</h1><p>Software engineer in Lisbon. I build reliable backend systems.</p>
    <nav><a href="/work">Work</a> <a href="/about">About</a> <a href="/blog">Blog</a> <a href="/resume.pdf">Resume</a> <a href="mailto:sam@example.invalid">Email me</a></nav></body>`,
  // Ten words or fewer with "start" in a sentence, and links out.
  "/startword": `<!doctype html><title>Jane Doe</title><body style="font:20px system-ui;padding:40px"><h1>Jane Doe</h1><p>Designer. Let's start something.</p>
    <p><a href="https://code.invalid/jane">GitHub</a> <a href="https://social.invalid/jane">LinkedIn</a></p></body>`,
  // A short bio that jokes about robots.
  "/robotbio": `<!doctype html><title>Sam Park</title><body style="font:20px system-ui;padding:40px"><h1>Hi, I'm Sam.</h1><p>Developer, climber, definitely not a robot.</p>
    <p><a href="https://code.invalid/sam">GitHub</a> <a href="https://social.invalid/sam">LinkedIn</a> <a href="mailto:sam@example.invalid">Email</a></p></body>`,
  // A minimal portfolio with the notice reCAPTCHA requires on its contact form.
  "/recaptchanotice": `<!doctype html><title>Ana Ruiz</title><body style="font:20px system-ui;padding:40px"><h1>Ana Ruiz</h1><p>Product designer in Madrid.</p>
    <p><a href="https://code.invalid/ana">GitHub</a> <a href="https://social.invalid/ana">LinkedIn</a></p>
    <small>This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.</small></body>`,
  // "I'm not a robot" in the title of an ordinary page.
  "/robottitle": `<!doctype html><title>Jane Doe - I'm not a robot</title><body style="font:18px system-ui;padding:40px"><h1>Jane Doe</h1>
    <p>${"I design and build calm, fast interfaces for small teams. ".repeat(7)}</p><a href="https://code.invalid/jane">GitHub</a></body>`,
  // Still a gate: "Start" as a button's whole text that never opens anything (the click does nothing).
  "/startgate": `<!doctype html><title>Jane</title><body style="margin:0;background:#000;color:#fff;font:30px system-ui"><div style="height:100vh;display:grid;place-items:center"><div><p>Jane Doe, welcome to my creative studio</p><button style="font-size:30px">Start</button></div></div></body>`,
  // Still a bot wall: a nearly empty page that asks to prove you are not a robot.
  "/robotwall": `<!doctype html><title>Security check</title><body style="font:20px system-ui;padding:40px"><h1>One more step</h1><p>Please verify you are not a robot to continue to example.dev.</p><a href="https://captcha.invalid/privacy">Privacy</a></body>`,
  // A 55-word interstitial with a challenge form, served with HTTP 200.
  "/waf": WAF,
  // The same interstitial on a refresh of a site that has a good capture.
  "/wafrefresh": WAF,
};

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;
const OLD_TEXT = "Old good page text of the portfolio";
const OLD_AT = "2026-07-01 00:00:00";

// Eleven captures side by side while other test files run: far more than the runner's per-test timeout.
before(async () => {
  server = http.createServer((req, res) => res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-short-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  await db.execute({
    sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', 'oldkey00oldkey00', '{}', ?, '{}', ?, ?)",
    args: [url("/wafrefresh"), OLD_TEXT, OLD_AT, OLD_AT],
  });
  browser = await chromium.launch();
  await Promise.all(
    Object.keys(pages).map(async (p) => {
      results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root, refresh: p === "/wafrefresh" });
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
const stored = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p)), "hero.jpg"));

for (const [p, what] of [
  ["/shorthome", "the short home page of a multi-page site"],
  ["/startword", 'a short page with "start" in a sentence'],
  ["/robotbio", 'a short bio that says "not a robot"'],
  ["/recaptchanotice", "a minimal page with Google's reCAPTCHA notice"],
  ["/robottitle", `a page titled "I'm not a robot"`],
]) {
  test(`${what} is captured as live`, async () => {
    assert.match(results[p], /^live/, results[p]);
    const row = await rowOf(p);
    assert.equal(row.status, "live");
    assert.equal(row.reason, "");
    assert.ok(stored(p), "hero.jpg written");
  });
}

test("a canvas-only page that drew something goes to the owner's review: not graded, not a blocked reason", async () => {
  assert.equal(results["/canvas"], `error (${MEDIA_REVIEW_REASON})`);
  const row = await rowOf("/canvas");
  assert.equal(row.status, "error");
  assert.equal(row.reason, MEDIA_REVIEW_REASON);
  assert.equal(isBlockedReason(row.reason), false, "the health check never fails it as blocked");
  assert.equal(Number(row.needs_review), 1);
  assert.equal(row.page_text, null);
  assert.equal(stored("/canvas"), false);
});

test("a canvas that never rendered (a flat black screen) is blocked as blank", async () => {
  assert.equal(results["/blackcanvas"], `blocked (${BLANK_FRAME})`);
  const row = await rowOf("/blackcanvas");
  assert.equal(row.reason, `${BLOCKED_PREFIX}${BLANK_FRAME}`);
  assert.equal(Number(row.needs_review), 0);
  assert.equal(stored("/blackcanvas"), false);
});

test("a gate word as a button's whole text, and a short page asking to prove you are not a robot, stay blocked", async () => {
  assert.equal(results["/startgate"], "blocked (still a gate or loader after the click-through)");
  assert.equal(results["/robotwall"], `blocked (${BOT_WALL})`);
  assert.equal((await rowOf("/robotwall")).reason, `${BLOCKED_PREFIX}${BOT_WALL}`);
  assert.equal(Number((await rowOf("/robotwall")).needs_review), 1);
  for (const p of ["/startgate", "/robotwall"]) assert.equal(stored(p), false);
});

test("a 55-word challenge interstitial served with HTTP 200 is a bot wall, and never replaces a good capture", async () => {
  assert.equal(results["/waf"], `blocked (${BOT_WALL})`);
  assert.equal(Number((await rowOf("/waf")).needs_review), 1);
  assert.equal(stored("/waf"), false);
  assert.equal(results["/wafrefresh"], `blocked (${BOT_WALL}); the existing capture is kept`);
  const row = await rowOf("/wafrefresh");
  assert.equal(row.status, "live");
  assert.equal(row.page_text, OLD_TEXT);
  assert.equal(row.captured_at, OLD_AT);
});
