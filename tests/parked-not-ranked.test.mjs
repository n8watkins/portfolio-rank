// A parking page is never stored as a good capture, so the capture's Starting
// rank hook (pipeline/capture.mjs, lib/tiers-store.mjs rankFromCode, called
// only after a good capture is stored) never ranks it. End to end in headless,
// muted Chromium against local pages, on a throwaway database with a tier
// library already built (so the hook really ranks a site that qualifies):
//   - nic-nguyen.com's home page and GoDaddy lander as served on 2026-11-23
//     (tests/fixtures/parked), which the plain pre-check rejects;
//   - a home page whose redirect the pre-check cannot read, to a lander drawn
//     by script, which only the capture's own judgement rejects;
//   - a real portfolio behind a language redirect, captured and ranked: the
//     control that shows the hook runs in this setup.
// Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { migrate } from "../lib/schema.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";
import { captureSite } from "../pipeline/capture.mjs";

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/parked/${f}`, import.meta.url), "utf8");
const CAPTURED = "2026-11-21 10:00:00";

const SITE = `<!doctype html><html lang="en"><head><title>Jane Doe - Software Engineer</title></head>
<body style="font:18px system-ui;max-width:800px;margin:40px auto">
<header><h1>Jane Doe</h1><nav><a href="#about">About</a> <a href="#projects">Projects</a> <a href="#contact">Contact</a></nav></header>
<section id="about"><h2>About me</h2><p>${"I am a backend engineer who builds payment systems and developer tools that stay up at three in the morning. ".repeat(4)}</p></section>
<section id="projects"><h2>Projects</h2>
<article><h3>Ledger</h3><p>A double-entry ledger service in Go with a small web console.</p><a href="https://github.invalid/janedoe/ledger">Code</a> <a href="https://ledger.invalid">Live demo</a></article>
<article><h3>Queue</h3><p>A job queue for Postgres with retries and a dashboard.</p><a href="https://github.invalid/janedoe/queue">Code</a> <a href="https://queue.invalid">Live demo</a></article>
<article><h3>Lint</h3><p>A linter for SQL migrations used by three teams.</p><a href="https://github.invalid/janedoe/lint">Code</a> <a href="https://lint.invalid">Live demo</a></article>
</section>
<section id="contact"><h2>Contact</h2><a href="mailto:jane@example.invalid">Email me</a> <a href="https://github.com/janedoe">GitHub</a> <a href="/resume.pdf">Resume</a></section>
<footer>© 2026 Jane Doe</footer></body></html>`;

const pages = {
  "/nic/": fixture("godaddy-root.html"),
  "/lander": fixture("godaddy-lander.html"),
  "/built/": `<!doctype html><html><head><script>window.onload=function(){window.location.href="/built/"+"lander"}</script></head></html>`,
  "/built/lander": `<!doctype html><html><head><title></title></head><body><div id=root></div><script>
    setTimeout(()=>{document.getElementById("root").innerHTML='<h1>janedoe.dev</h1><p>has expired and is parked free, courtesy of GoDaddy.com.</p><p><a href="https://registrar.invalid/buy">Get This Domain</a></p><p>Related Search Topics</p>'},300)</script></body></html>`,
  "/real/": `<!doctype html><html><head><script>location.replace("/real/en/")</script></head><body></body></html>`,
  "/real/en/": SITE,
};

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;

/** A library of 60 graded members, built once (as tests/rank-from-code.test.mjs), so a qualifying capture gets a rank. */
async function library(client) {
  const axis = (n) => ({ score: n, note: "" });
  const grade = (n) => ({ is_portfolio: true, tier: "B", model: "gemini-test", rubric_version: 2, visual_design: axis(n), five_second_test: axis(n), storytelling: axis(n), writing: axis(n), memorability: axis(n), quality_score: n, checks_score: 50, judged_at: "2026-11-10T00:00:00Z" });
  const signals = { name: true, projects: true, about: true, contact: true, resume: true, github: false, score: 5 };
  const facts = { v: 2, resume: true, github: true, contact: true, own_domain: true, footer_year: 2026, project_links: { checked: 3, ok: 3, broken: 0, blocked: 0 }, signals, measured_at: "2026-11-21T10:00:00Z" };
  await client.batch(
    Array.from({ length: 60 }, (_, i) => ({
      sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, ai_rubric, facts) VALUES (?, 'live', 'k', ?, ?, ?)",
      args: [`https://graded${i}.example/`, CAPTURED, JSON.stringify(grade(1 + (i % 5))), JSON.stringify(facts)],
    })),
    "write"
  );
  await refreshTiers(client, { now: Date.now() - 86_400_000 });
}

before(async () => {
  server = http.createServer((req, res) => {
    const html = pages[req.url];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html" }).end(html ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "parked-not-ranked-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  await library(db);
  browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
  for (const p of ["/nic/", "/built/", "/real/"]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, name, status) VALUES (?, 'Jane Doe', 'pending')", args: [url(p)] });
  }
  await Promise.all(["/nic/", "/built/", "/real/"].map(async (p) => (results[p] = await captureSite(browser, { url: url(p), name: "Jane Doe" }, { db, s3: null, root }))));
}, { timeout: 600000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const ranked = async (p) => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?", args: [url(p)] })).rows[0].n);
const rowOf = async (p) => (await db.execute({ sql: "SELECT status, reason, shot_key, page_text FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];

test("a parking page rejected by the pre-check or by the capture's own judgement is never stored, so never ranked", async () => {
  assert.equal(results["/nic/"], "parked (parking page: GoDaddy parking lander)");
  assert.equal(results["/built/"], 'parked (parking phrase: "has expired and is parked")');
  for (const p of ["/nic/", "/built/"]) {
    const row = await rowOf(p);
    assert.deepEqual([row.status, row.shot_key, row.page_text], ["parked", null, null], p);
    assert.equal(await ranked(p), 0, `${p} has no Starting rank`);
  }
});

test("the control: a real portfolio behind a language redirect is stored and ranked by the same hook", async () => {
  assert.match(results["/real/"], /^live/, results["/real/"]);
  assert.equal((await rowOf("/real/")).status, "live");
  assert.equal(await ranked("/real/"), 1, "the capture's rank hook ran in this setup");
});
