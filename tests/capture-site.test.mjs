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
import { ensureCaptureProblemSchema } from "../lib/capture-problems.mjs";
import { ensureReviewSchema } from "../lib/reviews/store.mjs";
import { FACTS_VERSION } from "../pipeline/facts.mjs";
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
  // A refresh of a site that had a résumé link and a long text, now without either.
  "/refresh-worse": `<!doctype html><title>Jane Doe</title><body>${SITE}</body>`,
  // A refresh whose phone view (the browser's second visit) meets a bot check: see the server below.
  "/phone-bot": `<!doctype html><title>Jane Doe</title><body>${SITE}</body>`,
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
  const visits = {};
  server = http.createServer((req, res) => {
    if (req.url === "/bot" || req.url === "/refresh-bot") return res.writeHead(403, { "content-type": "text/html" }).end(BOT);
    // The browser's page loads only (the plain pre-check sends no sec-fetch-dest): the second is the phone view.
    if (req.url === "/phone-bot" && req.headers["sec-fetch-dest"] === "document" && (visits[req.url] = (visits[req.url] ?? 0) + 1) >= 2) {
      return res.writeHead(403, { "content-type": "text/html" }).end(BOT);
    }
    res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-site-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  // A failed refresh records its backoff there (capture.mjs's main creates it the same way).
  await ensureFreshnessSchema(db);
  // What a re-capture made worse is recorded there (capture.mjs's main creates it the same way).
  await ensureCaptureProblemSchema(db);
  // Sites that already have a good capture.
  for (const p of ["/refresh", "/forced", "/refresh-bot", "/phone-bot"]) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', ?, ?, ?, '{}', ?, ?)",
      args: [url(p), OLD.shot_key, OLD.meta, OLD.page_text, OLD.captured_at, OLD.captured_at],
    });
  }
  // One whose stored capture had a résumé link and a long text.
  await db.execute({
    sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, meta, page_text, facts, checked_at, captured_at) VALUES (?, 'Old Site', 'live', '', ?, ?, ?, ?, ?, ?)",
    args: [url("/refresh-worse"), OLD.shot_key, OLD.meta, "Jane Doe. ".repeat(300), JSON.stringify({ v: FACTS_VERSION, resume: true, github: false, contact: false }), OLD.captured_at, OLD.captured_at],
  });
  browser = await chromium.launch();
  const run = async (p, opts = {}) => {
    results[p] = await captureSite(browser, { url: url(p), name: p === "/minimal" ? "Sam Lee" : "Jane Doe" }, { db, s3: null, root, ...opts });
  };
  await Promise.all([run("/picker"), run("/minimal"), run("/empty"), run("/bot"), run("/refresh", { refresh: true }), run("/forced")]);
  // The refreshes for the review flag and the worse-capture record, after the first six (the machine is shared).
  await Promise.all([run("/refresh-bot", { refresh: true }), run("/phone-bot", { refresh: true }), run("/refresh-worse", { refresh: true })]);
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
  // The capture writes no review row for a new site (the night's syncReviewRows does). The table may
  // exist already (a blocked refresh below writes one); make sure it does, so a bad query fails here.
  await ensureReviewSchema(db);
  const queue = await db.execute({ sql: "SELECT COUNT(*) AS n FROM status_reviews WHERE url IN (?, ?)", args: [url("/empty"), url("/bot")] });
  assert.equal(Number(queue.rows[0].n), 0, "nothing is sent to the review queue");
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
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = '{\"tier\":\"B\",\"is_portfolio\":true}' WHERE url IN (?, ?, ?, ?, ?)", args: [url("/refresh"), url("/forced"), url("/refresh-bot"), url("/phone-bot"), url("/refresh-worse")] });
  const ctx = {
    db,
    plan: DEFAULT_PLAN,
    quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
    rpm: 8,
    now: () => Date.parse("2026-11-17T04:30:00Z"),
    sleep: async () => {},
    log: () => {},
    flags: { rankingV2: false,ranking: rankingConfig({}) },
    runId: "test",
  };
  const state = await planNight(ctx, await startNight(ctx));
  const live = (await db.execute("SELECT url FROM portfolios WHERE status = 'live' AND ai_rubric IS NULL AND facts IS NOT NULL")).rows.map((r) => String(r.url)).sort();
  assert.deepEqual(live, [url("/minimal"), url("/picker")].sort(), "the captures that show the site have their evidence");
  assert.equal(state.estimate.perStage.grade_new, live.length, "the blocked ones never wait for a grade");
});

test("a refresh that meets a bot check puts the site on the owner's review list and keeps its capture", async () => {
  assert.match(results["/refresh-bot"], /a bot or security check stood in for the site\); the existing capture is kept$/);
  const row = await rowOf("/refresh-bot");
  assert.equal(Number(row.needs_review), 1);
  assert.equal(row.status, "live");
  assert.equal(row.shot_key, OLD.shot_key);
  assert.equal(row.page_text, OLD.page_text);
  const failure = (await db.execute({ sql: "SELECT reason FROM refresh_failures WHERE url = ?", args: [url("/refresh-bot")] })).rows[0];
  assert.equal(failure.reason, `error: ${BLOCKED_PREFIX}${BOT_WALL}`);
  // The review list is the pending row (lib/reviews/door.mjs blockedRefreshReview), with the stored capture's screenshots.
  const reviews = (await db.execute({ sql: "SELECT grp, proposed, shot_key, reason FROM status_reviews WHERE url = ? AND status = 'pending'", args: [url("/refresh-bot")] })).rows;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].grp, "recapture_blocked");
  assert.equal(reviews[0].proposed, "review");
  assert.equal(reviews[0].shot_key, OLD.shot_key);
  assert.match(String(reviews[0].reason), /^A nightly re-capture of this listed site met a bot or security check/);
});

test("a bot check only on the phone view of a refresh is a refresh failure with that reason, not a review", async () => {
  assert.match(results["/phone-bot"], /\(phone view\)\); the existing capture is kept$/);
  const row = await rowOf("/phone-bot");
  assert.equal(Number(row.needs_review), 0);
  assert.equal(row.shot_key, OLD.shot_key);
  const failure = (await db.execute({ sql: "SELECT reason FROM refresh_failures WHERE url = ?", args: [url("/phone-bot")] })).rows[0];
  assert.equal(failure.reason, `error: ${BLOCKED_PREFIX}${BOT_WALL} (phone view)`);
  await ensureReviewSchema(db);
  const reviews = await db.execute({ sql: "SELECT COUNT(*) AS n FROM status_reviews WHERE url = ?", args: [url("/phone-bot")] });
  assert.equal(Number(reviews.rows[0].n), 0);
});

test("a refresh that loses the résumé link and most of the text is recorded as worse", async () => {
  assert.match(results["/refresh-worse"], /^live/);
  const rows = (await db.execute({ sql: "SELECT * FROM capture_changes WHERE url = ?", args: [url("/refresh-worse")] })).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(String(rows[0].lost)), ["resume", "text"]);
  assert.equal(Number(rows[0].measuring), 0);
  assert.equal(Number(rows[0].old_chars), "Jane Doe. ".repeat(300).length);
  assert.ok(Number(rows[0].new_chars) < 900);
  assert.equal(rows[0].cleared_at, null);
});
