// Real portfolios that the blocked rules (pipeline/capture-blocked.mjs) used
// to turn away, captured end to end by the nightly capture
// (pipeline/capture.mjs captureSite) in headless Chromium against local
// pages: a canvas-only site with no DOM text, the short home page of a
// multi-page site, a few words with "start" in a sentence, and a short bio
// that says "not a robot". Each is stored as live; the real walls next to
// them (a gate word as a button's whole text, a nearly empty page that asks
// to prove you are not a robot) stay blocked. Every outbound link points at
// .invalid hosts, so nothing leaves the machine.
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
import { ensureRosterSchema } from "../pipeline/roster.mjs";

const pages = {
  // Flutter web or three.js: the whole site drawn on a canvas, no DOM text or links.
  "/canvas": `<!doctype html><title>Jane Doe - Portfolio</title><body style="margin:0"><canvas id=c width=1440 height=900 style="display:block;width:100vw;height:100vh"></canvas><script>
    const x=c.getContext("2d");x.fillStyle="#123";x.fillRect(0,0,1440,900);x.fillStyle="#fff";x.font="80px sans-serif";x.fillText("Jane Doe - Creative Developer",120,300);x.font="30px sans-serif";x.fillText("Projects   About   Contact",120,400);</script></body>`,
  // A short home page: name, one sentence, its own navigation and a mailto link.
  "/shorthome": `<!doctype html><title>Sam Lee</title><body style="font:20px system-ui;padding:40px"><h1>Sam Lee</h1><p>Software engineer in Lisbon. I build reliable backend systems.</p>
    <nav><a href="/work">Work</a> <a href="/about">About</a> <a href="/blog">Blog</a> <a href="/resume.pdf">Resume</a> <a href="mailto:sam@example.invalid">Email me</a></nav></body>`,
  // Ten words or fewer with "start" in a sentence, and links out.
  "/startword": `<!doctype html><title>Jane Doe</title><body style="font:20px system-ui;padding:40px"><h1>Jane Doe</h1><p>Designer. Let's start something.</p>
    <p><a href="https://code.invalid/jane">GitHub</a> <a href="https://social.invalid/jane">LinkedIn</a></p></body>`,
  // A short bio that jokes about robots.
  "/robotbio": `<!doctype html><title>Sam Park</title><body style="font:20px system-ui;padding:40px"><h1>Hi, I'm Sam.</h1><p>Developer, climber, definitely not a robot.</p>
    <p><a href="https://code.invalid/sam">GitHub</a> <a href="https://social.invalid/sam">LinkedIn</a> <a href="mailto:sam@example.invalid">Email</a></p></body>`,
  // Still a gate: "Start" as a button's whole text that never opens anything (the click does nothing).
  "/startgate": `<!doctype html><title>Jane</title><body style="margin:0;background:#000;color:#fff;font:30px system-ui"><div style="height:100vh;display:grid;place-items:center"><div><p>Jane Doe, welcome to my creative studio</p><button style="font-size:30px">Start</button></div></div></body>`,
  // Still a bot wall: a nearly empty page that asks to prove you are not a robot.
  "/robotwall": `<!doctype html><title>Security check</title><body style="font:20px system-ui;padding:40px"><h1>One more step</h1><p>Please verify you are not a robot to continue to example.dev.</p><a href="https://captcha.invalid/privacy">Privacy</a></body>`,
};

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;

before(async () => {
  server = http.createServer((req, res) => res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-short-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  browser = await chromium.launch();
  await Promise.all(
    Object.keys(pages).map(async (p) => {
      results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root });
    })
  );
});

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const stored = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p)), "hero.jpg"));

for (const [p, what] of [
  ["/canvas", "a canvas-only site (no DOM text, no links)"],
  ["/shorthome", "the short home page of a multi-page site"],
  ["/startword", 'a short page with "start" in a sentence'],
  ["/robotbio", 'a short bio that says "not a robot"'],
]) {
  test(`${what} is captured as live`, async () => {
    assert.match(results[p], /^live/, results[p]);
    const row = await rowOf(p);
    assert.equal(row.status, "live");
    assert.equal(row.reason, "");
    assert.ok(stored(p), "hero.jpg written");
  });
}

test("a gate word as a button's whole text, and a short page asking to prove you are not a robot, stay blocked", async () => {
  assert.equal(results["/startgate"], "blocked (still a gate or loader after the click-through)");
  assert.equal(results["/robotwall"], `blocked (${BOT_WALL})`);
  assert.equal((await rowOf("/robotwall")).reason, `${BLOCKED_PREFIX}${BOT_WALL}`);
  assert.equal(Number((await rowOf("/robotwall")).needs_review), 1);
  for (const p of ["/startgate", "/robotwall"]) assert.equal(stored(p), false);
});
