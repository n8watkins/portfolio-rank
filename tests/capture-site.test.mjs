// The nightly capture of one site (pipeline/capture.mjs captureSite), end to
// end against local pages in headless Chromium, with a throwaway local
// database and no storage bucket: a site behind a mode picker is
// photographed behind it; a capture that does not show the site is never
// stored and never reaches the grading queue (pipeline/night.mjs); a new
// site's blocked capture is a failed capture with a retry; a refresh that
// comes back blocked keeps the good capture it had. Every outbound link
// points at .invalid hosts, so nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import jpeg from "jpeg-js";
import { chromium } from "playwright";
import { captureSite, keyOf } from "../pipeline/capture.mjs";
import { BLOCKED_PREFIX, BOT_WALL } from "../pipeline/capture-blocked.mjs";
import { dueForCapture, ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { DEFAULT_PLAN } from "../pipeline/budget.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";
import { planNight, startNight } from "../pipeline/night.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";

const SITE = `<main style="font:18px system-ui;max-width:800px;margin:40px auto">
<h1>Jane Doe</h1><h2>Backend engineer</h2>
<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(6)}</p>
<ul><li><a href="https://code.invalid/jane/ledger">Ledger</a>: a double-entry ledger in Go.</li></ul>
<p><a href="https://social.invalid/jane">Profile</a></p></main>`;

const pages = {
  // Opens on a picker on a dark screen; either choice shows the site on white.
  "/picker": `<!doctype html><title>Jane Doe</title><body style="margin:0;background:#111;color:#eee;font:20px system-ui">
    <div style="height:100vh;display:grid;place-items:center;text-align:center"><div><p>How would you like to see this site?</p>
    <button id=r style="font-size:20px;padding:12px 24px">Recruiter</button> <button id=d style="font-size:20px;padding:12px 24px">Developer</button></div></div>
    <script>const show=()=>{document.body.style.background="#fff";document.body.style.color="#111";document.body.innerHTML=${JSON.stringify(SITE)}};r.onclick=show;d.onclick=show</script></body>`,
  // A minimalist one-screen portfolio: few words, a few links out.
  "/minimal": `<!doctype html><title>Sam Lee</title><body style="font:20px system-ui;padding:40px"><h1>Sam Lee</h1><p>Designer and engineer in Lisbon.</p>
    <p><a href="/work">Work</a> <a href="/about">About</a> <a href="https://code.invalid/sam">Code</a> <a href="https://social.invalid/sam">Profile</a></p></body>`,
  // Nearly empty: enough text to pass the blank check, no links out.
  "/empty": `<!doctype html><title>Home</title><body><p>Hello there, welcome to my new website, coming along soon</p></body>`,
  // A refresh of a good site that now comes back nearly empty.
  "/refresh": `<!doctype html><title>Home</title><body><p>Hello there, welcome to my new website, coming along soon</p></body>`,
  // A forced re-capture (not marked refresh) of a site with a good capture.
  "/forced": `<!doctype html><title>Home</title><body><p>Hello there, welcome to my new website, coming along soon</p></body>`,
};
// A bot check in place of the site, answered with 403 like Cloudflare's.
const BOT = `<!doctype html><title>Just a moment...</title><body><h1>example.dev</h1><p>Verifying you are human. This may take a few seconds.</p>
  <p>example.dev needs to review the security of your connection before proceeding.</p></body>`;

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;
const OLD = { shot_key: "oldkey00oldkey00", meta: JSON.stringify({ motion: false, fullPage: { v: "old" } }), page_text: "Old good page text of the portfolio", captured_at: "2026-10-01 00:00:00" };

// Six captures side by side while other test files run: far more than the runner's per-test timeout.
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/bot") return res.writeHead(403, { "content-type": "text/html" }).end(BOT);
    res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-site-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  // A failed refresh records its backoff there (capture.mjs's main creates it the same way).
  await ensureFreshnessSchema(db);
  // Two sites that already have a good capture.
  for (const p of ["/refresh", "/forced"]) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', ?, ?, ?, '{}', ?, ?)",
      args: [url(p), OLD.shot_key, OLD.meta, OLD.page_text, OLD.captured_at, OLD.captured_at],
    });
  }
  browser = await chromium.launch();
  const run = async (p, opts = {}) => {
    results[p] = await captureSite(browser, { url: url(p), name: p === "/minimal" ? "Sam Lee" : "Jane Doe" }, { db, s3: null, root, ...opts });
  };
  await Promise.all([run("/picker"), run("/minimal"), run("/empty"), run("/bot"), run("/refresh", { refresh: true }), run("/forced")]);
}, { timeout: 600000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const captured = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p))));

/** Mean brightness (0 to 255) of a JPEG. */
function brightness(file) {
  const { data } = jpeg.decode(fs.readFileSync(file), { useTArray: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  return sum / (data.length / 4);
}

test("a site behind a mode picker is photographed behind it, on desktop and phone", async () => {
  assert.match(results["/picker"], /^live/);
  const row = await rowOf("/picker");
  assert.equal(row.status, "live");
  const meta = JSON.parse(String(row.meta));
  assert.equal(meta.mode.picked, "Recruiter");
  assert.equal(meta.mode.passed, true);
  assert.equal(meta.mode.mobile, true, "the phone view passed it too");
  assert.equal(meta.action, 'picked "Recruiter"');
  assert.match(String(row.page_text), /Jane Doe/);
  assert.doesNotMatch(String(row.page_text), /How would you like/);
  // The picker is dark, the site white: the stored frames are of the site.
  const dir = path.join(root, "captures", keyOf(url("/picker")));
  assert.ok(brightness(path.join(dir, "hero.jpg")) > 200, "hero.jpg shows the site, not the picker");
  assert.ok(brightness(path.join(dir, "mobile.jpg")) > 200, "mobile.jpg shows the site, not the picker");
});

test("a minimalist one-screen portfolio with a few links is captured, not blocked", async () => {
  assert.match(results["/minimal"], /^live/);
  assert.equal((await rowOf("/minimal")).status, "live");
});

test("a new site whose capture is blocked is a failed capture with a retry, and nothing is stored", async () => {
  for (const [p, why] of [
    ["/empty", "10 words and no outbound links"],
    ["/bot", BOT_WALL],
  ]) {
    assert.equal(results[p], `blocked (${why})`);
    const row = await rowOf(p);
    assert.equal(row.status, "error");
    assert.equal(row.reason, `${BLOCKED_PREFIX}${why}`);
    assert.equal(Number(row.capture_attempts), 1);
    const days = (Date.parse(String(row.retry_at)) - Date.now()) / 86400000;
    assert.ok(days > 0.9 && days < 1.1, `retried in a day, got ${days}`);
    assert.equal(row.shot_key, null);
    assert.equal(row.page_text, null);
    assert.equal(row.meta, null);
    assert.equal(captured(p), false, "no screenshot written");
  }
  // The bot wall is marked for the owner's review; the empty page is not (it ends as broken).
  assert.equal(Number((await rowOf("/bot")).needs_review), 1);
  assert.equal(Number((await rowOf("/empty")).needs_review), 0);
  const queue = await db.execute("SELECT name FROM sqlite_master WHERE name = 'status_reviews'");
  assert.equal(queue.rows.length, 0, "nothing is sent to the review queue");
  // Retried on a later night: not due tonight, due once the backoff runs out.
  const entries = [{ url: url("/empty") }, { url: url("/bot") }];
  assert.deepEqual(await dueForCapture(db, entries), []);
  const later = new Date(Date.now() + 2 * 86400000);
  assert.deepEqual((await dueForCapture(db, entries, later)).map((e) => e.url), entries.map((e) => e.url));
});

test("a refresh that comes back blocked keeps the good capture, and so does a forced re-capture", async () => {
  assert.equal(results["/refresh"], "blocked (10 words and no outbound links); the existing capture is kept");
  assert.equal(results["/forced"], "blocked (10 words and no outbound links); the existing capture is kept");
  for (const p of ["/refresh", "/forced"]) {
    const row = await rowOf(p);
    assert.equal(row.status, "live");
    assert.equal(row.reason, "");
    assert.equal(row.shot_key, OLD.shot_key);
    assert.equal(row.meta, OLD.meta);
    assert.equal(row.page_text, OLD.page_text);
    assert.equal(row.captured_at, OLD.captured_at);
    assert.equal(Number(row.capture_attempts), 0);
    assert.equal(captured(p), false);
  }
});

test("only the capture that shows the site reaches the grading queue", async () => {
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await db.execute(`CREATE TABLE IF NOT EXISTS votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  // The two good old captures are graded already; only new captures wait.
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = '{\"tier\":\"B\",\"is_portfolio\":true}' WHERE url IN (?, ?)", args: [url("/refresh"), url("/forced")] });
  const ctx = {
    db,
    plan: DEFAULT_PLAN,
    quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
    rpm: 8,
    now: () => Date.parse("2026-11-17T04:30:00Z"),
    sleep: async () => {},
    log: () => {},
    flags: { rankingV2: false, rubricRegrade: false, ranking: rankingConfig({}) },
    runId: "test",
  };
  const state = await planNight(ctx, await startNight(ctx));
  const live = (await db.execute("SELECT url FROM portfolios WHERE status = 'live' AND ai_rubric IS NULL AND facts IS NOT NULL")).rows.map((r) => String(r.url)).sort();
  assert.deepEqual(live, [url("/minimal"), url("/picker")].sort(), "the captures that show the site have their evidence");
  assert.equal(state.estimate.perStage.grade_new, live.length, "the blocked ones never wait for a grade");
});
