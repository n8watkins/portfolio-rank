// The not-working pool (pipeline/not-working.mjs, pipeline/recheck.mjs;
// owner, 2026-11-16): a site that stops answering leaves the AI's work at its
// first failed check, is hidden when its re-check the next day fails too,
// comes back by itself as it was, and leaves the list after 90 days. Offline:
// a throwaway database, a simulated clock, stand-ins for the plain request
// and the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as health from "../pipeline/health.mjs";
import * as pool from "../pipeline/not-working.mjs";
import { controlSites, dueForRecheck, recheckSummary, runRecheck } from "../pipeline/recheck.mjs";
import { EXPORT_EVERY_DAYS, exportDue, markExported, planExclusions } from "../pipeline/exclusions.mjs";
import { ACTIVE, LISTED_NOT_DOWN, dueForCapture } from "../pipeline/roster.mjs";
import { GONE_WHERE, HIDDEN_WHERE } from "../lib/hidden.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { regradeQueue, versionRegradeQueue } from "../pipeline/rubric-history.mjs";
import { rowsNeedingEvidence } from "../pipeline/evidence.mjs";
import { heroCandidates } from "../pipeline/polls.mjs";
import { gradedPool } from "../lib/grader/report.mjs";
import { dueForFingerprint, ensureFreshnessSchema, lighthouseDue, linksDue, screenshotsDue } from "../lib/freshness.mjs";
import { fullPageDue } from "../pipeline/fullpage.mjs";
import { prewarmQueue } from "../scripts/lib/prewarm.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { PORTFOLIO_HTML, T0, answer, col, context, drive, freshDb, site } from "./helpers/door-night.mjs";

const quiet = () => {};
const H = 3600000;
const D = 86400000;
const at = (ms) => new Date(ms);

const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });
const goodPage = (url) => ({ status: 200, finalUrl: `${url}/`, title: "Ann Lee | Engineer", text: "Ann Lee builds web apps. Projects, about and contact.", media: false, html: PORTFOLIO_HTML });

/**
 * A world of sites whose answers the test sets: "ok", "paused" (HTTP 402, a
 * paused Vercel project), "gone" (the name does not resolve), "unsure" (the
 * connection drops and the browser times out: the check cannot tell), "down"
 * (nothing answers anywhere: a broken runner).
 */
function world() {
  const mode = new Map();
  const of = (u) => {
    for (const [url, m] of mode) if (u.startsWith(url)) return m;
    return mode.get("*") ?? "ok";
  };
  const fetchImpl = async (u) => {
    const m = of(u);
    if (m === "paused") return response(402, "This deployment is temporarily paused", u);
    if (m === "gone") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (m === "unsure" || m === "down") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    return response(200, PORTFOLIO_HTML, u);
  };
  const render = async (u) => {
    const m = of(u);
    if (m === "paused") return { status: 402, finalUrl: `${u}/`, title: "", text: "This deployment is temporarily paused", media: false, html: "" };
    if (m === "gone") throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${u}`);
    if (m === "unsure") throw new Error("page.goto: Timeout 30000ms exceeded.");
    if (m === "down") throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${u}`);
    return goodPage(u);
  };
  return { mode, fetchImpl, render };
}

const fillers = Array.from({ length: 30 }, (_, i) => ({ url: `https://filler-${i}.dev`, name: "Ann Lee" }));

async function setup(urls) {
  const { db } = await freshDb();
  for (const f of fillers) await site(db, f.url, { rubric: answer(true) });
  for (const u of urls) await site(db, u, { rubric: answer(true) });
  const feed = [...urls.map((url) => ({ url, name: "Ann Lee" })), ...fillers];
  const w = world();
  const nightly = (now) => health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  const hourly = (now) => runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  return { db, feed, w, nightly, hourly };
}

/** Where a site stands for the AI's work and for visitors. */
async function standing(db, url) {
  const one = async (where) => (await db.execute({ sql: `SELECT 1 FROM portfolios WHERE url = ? AND (${where})`, args: [url] })).rows.length === 1;
  return { ai: await one(ACTIVE()), hidden: await one(HIDDEN_WHERE), gone: await one(GONE_WHERE) };
}
const LIVE = { ai: true, hidden: false, gone: false };
const FAILING = { ai: false, hidden: false, gone: false };
const NOT_WORKING = { ai: false, hidden: true, gone: true };

const marks = async (db, url) => (await db.execute({ sql: "SELECT * FROM health_marks WHERE url = ?", args: [url] })).rows[0];

// ---------------------------------------------------------------------------
// The journey

test("a site's journey: first failure out of AI work, hidden after the next day's re-check, re-checked daily, weekly, monthly, back as it was", async () => {
  const url = "https://paused.example";
  const { db, w, nightly, hourly } = await setup([url]);
  // Its grade and its votes, which must survive.
  const grade = await col(db, url, "ai_rubric");
  await db.execute({ sql: "INSERT INTO votes (winner, loser, rater_id) VALUES (?, ?, 'r1'), (?, ?, 'r2')", args: [url, fillers[0].url, fillers[1].url, url] });
  const votes = async () => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE winner = ? OR loser = ?", args: [url, url] })).rows[0].n);

  await nightly(T0);
  assert.deepEqual(await standing(db, url), LIVE);

  // P1: the first failure (the nightly run): out of the AI's work at once, still shown.
  const F = T0 + D;
  w.mode.set(url, "paused");
  let s = await nightly(F);
  assert.deepEqual(s.newlyFailing.map((x) => x.url), [url]);
  assert.deepEqual(await standing(db, url), FAILING);
  assert.equal(await col(db, url, "health_reason"), "HTTP 402: deployment paused");

  // A second run on the same bad day leaves the site to the hourly re-check; the re-check is not due yet.
  s = await nightly(F + 10 * 60000);
  assert.equal(s.leftToRecheck, 1);
  assert.equal((await hourly(F + 20 * 60000)).due, 0, "not due 20 minutes after the first failure");
  assert.equal(Number((await marks(db, url)).pool_stage), pool.FAILING);

  // P2: the re-check about an hour later fails: still shown, out of the AI's work.
  s = await hourly(F + 50 * 60000);
  assert.equal(s.due, 1);
  assert.equal(Number((await marks(db, url)).pool_stage), pool.RECHECKED);
  assert.deepEqual(await standing(db, url), FAILING);
  // Nothing more until the next day: not on any hour, not on the next nightly run.
  for (let h = 2; h < 24; h++) assert.equal((await hourly(F + h * H)).due, 0, `hour ${h}`);
  assert.equal((await nightly(F + D - 5 * 60000)).leftToRecheck, 1);

  // P3: the next day's re-check fails: not working, hidden everywhere.
  const S = F + D;
  s = await hourly(S);
  assert.deepEqual(s.newlyHidden.map((x) => x.url), [url]);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
  assert.equal(await col(db, url, "health"), "down");
  assert.equal((await marks(db, url)).pool_since, at(S).toISOString());
  assert.match(recheckSummary(s), /1 re-checked, 0 back, 0 failing for the first time \(out of AI work\), 1 newly hidden, 0 not working 90\+ days/);

  // P4: daily for the first week, weekly to day 30, then monthly; never before.
  const dueAt = async (t) => (await dueForRecheck(db, at(t))).map((x) => x.url).includes(url);
  const checkOn = async (day) => {
    assert.equal(await dueAt(S + day * D - H), false, `not due an hour before day ${day}`);
    assert.equal(await dueAt(S + day * D), true, `due on day ${day}`);
    const r = await hourly(S + day * D);
    assert.equal(r.aborted, false);
  };
  for (const day of [1, 2, 3, 4, 5, 6, 7]) await checkOn(day);
  for (const day of [14, 21, 28, 35]) await checkOn(day);
  await checkOn(65);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
  // The weekly export holds it: not 90 days yet.
  const plan = await planExclusions({ db, excluded: [], feed: [{ url, name: "Ann Lee" }, ...fillers], now: at(S + 65 * D) });
  assert.deepEqual(plan.added, []);
  assert.match(plan.held.map((h) => h.why).join(), /leaves the list after 90 days/);

  // It works again on day 70 (its next check is day 95; the owner's paused project came back).
  w.mode.set(url, "ok");
  assert.equal(await dueAt(S + 70 * D), false);
  // The nightly run leaves it to the re-check, so the re-check brings it back when due. Pull it forward
  // as a test of the return itself: the full check passes, and it is back as it was.
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [at(S + 70 * D).toISOString(), url] });
  s = await hourly(S + 70 * D);
  assert.deepEqual(s.returned, [{ url, wasNotWorking: true }]);
  assert.deepEqual(await standing(db, url), LIVE);
  assert.equal(await col(db, url, "health"), "live");
  assert.equal(await col(db, url, "ai_rubric"), grade, "the grade is untouched");
  assert.equal(await votes(), 2, "the votes are untouched");
  const m = await marks(db, url);
  assert.deepEqual([m.pool_stage, m.pool_next_at, m.pool_since], [null, null, null]);
  // And the nightly run checks it again like any site.
  assert.equal((await nightly(S + 71 * D)).leftToRecheck, 0);
});

test("a site that never answers again leaves the list at 90 days, through the weekly export", async () => {
  const url = "https://gone.example";
  const { db, feed, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "gone");
  const F = T0 + D;
  await nightly(F);
  await hourly(F + H);
  await hourly(F + D);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
  const S = F + D;
  const plan89 = await planExclusions({ db, excluded: [], feed, now: at(S + 89 * D) });
  assert.deepEqual(plan89.added, []);
  // Its monthly re-check still fails; the 90th day comes.
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [at(S + 90 * D).toISOString(), url] });
  const s = await hourly(S + 90 * D);
  assert.deepEqual(s.leavingList.map((x) => x.url), [url]);
  const plan = await planExclusions({ db, excluded: [], feed, now: at(S + 90 * D) });
  assert.deepEqual(plan.added.map((a) => [a.url, a.kind, a.reason]), [[url, "down", "DNS resolution failed"]]);
  assert.ok(!plan.feed.some((p) => p.url === url));
  // Nothing was deleted on the way: the row and its grade are still there (the 30-day purge comes after delisting).
  assert.ok(await col(db, url, "ai_rubric"));
});

test("a site whose re-check an hour later passes is never hidden", async () => {
  const url = "https://blip.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "paused");
  await nightly(T0 + D);
  assert.deepEqual(await standing(db, url), FAILING);
  w.mode.set(url, "ok");
  const s = await hourly(T0 + D + H);
  assert.deepEqual(s.returned, [{ url, wasNotWorking: false }]);
  assert.deepEqual(await standing(db, url), LIVE);
  assert.equal((await marks(db, url)).pool_stage, null);
  assert.equal((await hourly(T0 + 2 * D)).due, 0);
});

test("a re-check that could not tell neither hides nor restores; it is tried again the next hour", async () => {
  const url = "https://flaky-host.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "paused");
  const F = T0 + D;
  await nightly(F);
  await hourly(F + H);
  // The next day's re-check cannot tell: not hidden, not back, still due.
  w.mode.set(url, "unsure");
  let s = await hourly(F + D);
  assert.equal(s.due, 1);
  assert.deepEqual(await standing(db, url), FAILING);
  assert.equal(Number((await marks(db, url)).pool_stage), pool.RECHECKED);
  assert.equal((await dueForRecheck(db, at(F + D + H))).length, 1, "tried again the next hour");
  // It fails for real an hour later: hidden.
  w.mode.set(url, "paused");
  s = await hourly(F + D + H);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
  // A hidden site's re-check that cannot tell does not bring it back either.
  w.mode.set(url, "unsure");
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [at(F + 3 * D).toISOString(), url] });
  await hourly(F + 3 * D);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
});

test("a bot-walled site never enters the pool, whatever its answers", async () => {
  const url = "https://walled.example";
  const { db, w, hourly } = await setup([]);
  await site(db, url, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  const feed = [{ url, name: "Ann Lee" }, ...fillers];
  w.mode.set(url, "paused");
  for (const d of [0, 1, 2, 3]) await health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(T0 + d * D), log: quiet });
  assert.equal((await marks(db, url)).pool_stage, null);
  assert.notEqual(await col(db, url, "health"), "down");
  assert.equal((await hourly(T0 + 3 * D + H)).due, 0);
});

test("two failures on one bad day never skip a stage", () => {
  const fail = { ok: false, reason: "HTTP 402: deployment paused" };
  const F = T0;
  let s = health.nextHealth(null, fail, at(F));
  assert.equal(s.pool.stage, pool.FAILING);
  // Ten minutes later (a manual run): not the hour's re-check.
  s = health.nextHealth({ ...s, pool: s.pool }, fail, at(F + 10 * 60000));
  assert.equal(s.pool.stage, pool.FAILING);
  // The hour's re-check, then a run two hours later: not the next day's.
  s = health.nextHealth(s, fail, at(F + H));
  assert.equal(s.pool.stage, pool.RECHECKED);
  s = health.nextHealth(s, fail, at(F + 3 * H));
  assert.deepEqual([s.pool.stage, s.health], [pool.RECHECKED, "suspect"]);
  s = health.nextHealth(s, fail, at(F + D));
  assert.deepEqual([s.pool.stage, s.health], [pool.NOT_WORKING, "down"]);
  // Every cause is the same ladder (P8); a page that answers with the wrong thing is not on it (P7).
  for (const reason of ["HTTP 402: payment required (hosting paused)", "HTTP 404: deployment not found", "DNS resolution failed", "does not load (net::ERR_CONNECTION_REFUSED at x)", "connect timeout (nothing answers at the address)", "HTTP 503"]) {
    assert.equal(pool.notAnswering(reason), true, reason);
  }
  for (const reason of ['parking phrase: "domain for sale"', "renders blank", "redirects to linkedin.com, not a portfolio", "duplicate of https://a.dev", "capture blocked: still a gate"]) {
    assert.equal(pool.notAnswering(reason), false, reason);
    assert.equal(health.nextHealth(null, { ok: false, reason }, at(F)).pool, null, reason);
  }
});

test("the export to data/excluded.json stays weekly while the full check runs every night", async () => {
  const { db } = await freshDb();
  assert.equal(await exportDue(db, at(T0)), true, "never exported: due");
  await markExported(db, at(T0));
  for (let d = 1; d < EXPORT_EVERY_DAYS; d++) assert.equal(await exportDue(db, at(T0 + d * D)), false, `night ${d}`);
  assert.equal(await exportDue(db, at(T0 + EXPORT_EVERY_DAYS * D)), true);
});

test("the owner's numbers live in one place", () => {
  assert.equal(pool.RECHECK_AFTER_MS, H);
  assert.equal(pool.CONFIRM_AFTER_MS, D);
  assert.deepEqual(pool.POOL_CADENCE.map((c) => c.everyDays), [1, 7, 30]);
  assert.equal(pool.LEAVE_AFTER_DAYS, 90);
  assert.deepEqual([0, 6.9, 7, 29, 30, 80].map(pool.cadenceDays), [1, 1, 7, 7, 30, 30]);
});

// ---------------------------------------------------------------------------
// Guards: a broken runner records nothing

test("an hourly re-check whose control sites do not load records nothing and fails", async () => {
  const url = "https://paused-2.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "paused");
  await nightly(T0 + D);
  const before = await marks(db, url);
  // The runner's network is down: every site, controls included, refuses.
  w.mode.set("*", "down");
  w.mode.set(url, "down");
  const s = await hourly(T0 + D + H);
  assert.equal(s.aborted, true);
  assert.match(s.message, /control sites/);
  assert.match(recheckSummary(s), /FAILED/);
  assert.deepEqual(await marks(db, url), before, "nothing recorded");
  assert.equal((await controlSites(db, 5)).length, 5, "the controls are live listed sites");
});

test("an hourly re-check whose browser never starts records nothing and fails", async () => {
  const url = "https://paused-3.example";
  const { db, w, nightly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "paused");
  await nightly(T0 + D);
  const before = await marks(db, url);
  const s = await runRecheck({
    db,
    fetchImpl: async (u) => (u.startsWith(url) ? response(200, "<div id=root></div>", u) : response(200, PORTFOLIO_HTML, u)),
    render: async () => {
      throw new Error("browserType.launch: Executable doesn't exist");
    },
    now: at(T0 + D + H),
    log: quiet,
  });
  assert.equal(s.aborted, true);
  assert.deepEqual(await marks(db, url), before);
});

test("an hour with nothing due loads no site at all", async () => {
  const { db } = await setup([]);
  let calls = 0;
  const s = await runRecheck({ db, fetchImpl: async () => (calls++, response(200, "", "x")), now: at(T0), log: quiet });
  assert.deepEqual([s.due, calls], [0, 0]);
  assert.match(recheckSummary(s), /Nothing due/);
  // The count the workflow asks first, before any install, is the same query.
  const n = Number((await db.execute({ sql: pool.DUE_COUNT_SQL, args: [pool.dueCutoff(at(T0))] })).rows[0].n);
  assert.equal(n, 0);
});

test("the due count over Turso's HTTP API: one plain request, no packages", async () => {
  const { tursoCount } = await import("../pipeline/recheck-due.mjs");
  let seen;
  const fetchImpl = async (u, init) => {
    seen = { u, body: JSON.parse(init.body), auth: init.headers.authorization };
    return { ok: true, json: async () => ({ results: [{ type: "ok", response: { type: "execute", result: { rows: [[{ type: "integer", value: "3" }]] } } }, { type: "ok" }] }) };
  };
  assert.equal(await tursoCount("libsql://db-x.turso.io", "t0ken", pool.DUE_COUNT_SQL, ["2026-11-17T00:00:00.000Z"], fetchImpl), 3);
  assert.equal(seen.u, "https://db-x.turso.io/v2/pipeline");
  assert.equal(seen.auth, "Bearer t0ken");
  assert.equal(seen.body.requests[0].stmt.sql, pool.DUE_COUNT_SQL);
  const failing = async () => ({ ok: true, json: async () => ({ results: [{ type: "error", error: { message: "no such column: pool_next_at" } }] }) });
  await assert.rejects(tursoCount("libsql://db-x.turso.io", "t", "SELECT 1", [], failing), /no such column/);
});

// ---------------------------------------------------------------------------
// The capture lands mid-run, on an ordinary night

test("a capture that lands while the nightly run checks (a Wednesday) is never overwritten, and no stage is counted on the stale row", async () => {
  const url = "https://midrun.example";
  const { db, feed, w } = await setup([url]);
  const wednesday = Date.parse("2026-11-19T04:30:00Z");
  assert.equal(new Date(wednesday).getUTCDay(), 4, "Thursday UTC is Wednesday 20:30 in Los Angeles");
  await health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(wednesday - D), log: quiet });
  w.mode.set(url, "paused");
  // The nightly capture, started in the same minute, records a failed capture of this site just after the
  // run has read the rows and before it writes (a capture that lands earlier is simply read).
  let landed = false;
  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop !== "execute") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
      return async (q) => {
        const out = await target.execute(q);
        if (!landed && /AS decided_removal/.test(typeof q === "string" ? q : q.sql)) {
          landed = true;
          await target.execute({ sql: "UPDATE portfolios SET status = 'error', reason = 'HTTP 402' WHERE url = ?", args: [url] });
        }
        return out;
      };
    },
  });
  const s = await health.runHealthCheck({ db: racing, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(wednesday), concurrency: 1, log: quiet });
  assert.ok(landed);
  assert.ok(s.changedDuringRun.includes(url));
  assert.equal(await col(db, url, "status"), "error", "the capture's write stands");
  assert.equal(await col(db, url, "health"), "live", "no failure counted on the stale row");
  assert.equal((await marks(db, url))?.pool_stage ?? null, null);
  // The next night counts it.
  await health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(wednesday + D), log: quiet });
  assert.equal(Number((await marks(db, url)).pool_stage), pool.FAILING);
});

// ---------------------------------------------------------------------------
// Sites that were failing or down when this shipped

test("migration: a 'suspect' row from the weekly ladder joins the pool from its first failure; a 'down' one for not answering is not working since then", async () => {
  const suspect = "https://old-suspect.example";
  const down = "https://old-down.example";
  const blank = "https://old-blank.example";
  const { db, feed, w, nightly, hourly } = await setup([suspect, down, blank]);
  const now = T0;
  const set = (url, health, reason, firstDaysAgo, fails) =>
    db.execute({
      sql: "UPDATE portfolios SET health = ?, health_reason = ?, health_fails = ?, health_first_fail_at = ? WHERE url = ?",
      args: [health, reason, fails, at(now - firstDaysAgo * D).toISOString(), url],
    });
  await set(suspect, "suspect", "HTTP 404", 7, 1);
  await set(down, "down", "HTTP 402: deployment paused", 20, 3);
  await set(blank, "down", "renders blank", 20, 3);
  // Before any run of the new code: the content-ladder "down" goes at the weekly export as before; the
  // not-answering one waits until 90 days after its first failure.
  let plan = await planExclusions({ db, excluded: [], feed, now: at(now) });
  assert.deepEqual(plan.added.map((a) => a.url), [blank]);
  assert.match(plan.held.find((h) => h.url === down).why, /leaves the list after 90 days/);

  w.mode.set(suspect, "paused");
  w.mode.set(down, "paused");
  w.mode.set(blank, "ok");
  await nightly(now);
  // The old suspect failed a week ago and again now: this run counts as its first re-check.
  const ms = await marks(db, suspect);
  assert.equal(Number(ms.pool_stage), pool.RECHECKED);
  assert.equal(ms.pool_started_at, at(now - 7 * D).toISOString());
  assert.equal(ms.pool_next_at, at(now + H).toISOString(), "confirmed by the next hour's re-check, never within the hour");
  assert.deepEqual(await standing(db, suspect), FAILING);
  await hourly(now + H);
  assert.deepEqual(await standing(db, suspect), NOT_WORKING);
  // The old down site is in the pool since its first failure.
  const md = await marks(db, down);
  assert.deepEqual([Number(md.pool_stage), md.pool_since], [pool.NOT_WORKING, at(now - 20 * D).toISOString()]);
  plan = await planExclusions({ db, excluded: [], feed, now: at(now - 20 * D + 90 * D) });
  assert.ok(plan.added.some((a) => a.url === down));
  // The blank one passes now: back.
  assert.deepEqual(await standing(db, blank), LIVE);
});

// ---------------------------------------------------------------------------
// Out of the AI's work: every query that picks sites for it

test("out of AI work, per consumer: a failing site is skipped by every queue, a healthy one is not", async () => {
  const { db } = await freshDb();
  await ensureFreshnessSchema(db);
  const ok = "https://healthy.example";
  const failing = "https://failing.example";
  const hidden = "https://notworking.example";
  const oldGrade = { ...answer(true), tier: "A", model: "old-model", rubric_version: 0, judged_at: "2026-01-01T00:00:00Z" };
  for (const u of [ok, failing, hidden]) await site(db, u, { rubric: oldGrade });
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_reason = 'HTTP 402' WHERE url = ?", args: [failing] });
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'HTTP 402' WHERE url = ?", args: [hidden] });
  const only = (rows) => rows.map((r) => String(typeof r === "string" ? r : r.url)).filter((u) => [ok, failing, hidden].includes(u)).sort();
  const expectOk = (name, rows) => assert.deepEqual(only(rows), [ok], name);

  expectOk("grading: re-grade queue (pipeline/rubric-history.mjs regradeQueue)", await regradeQueue(db, { primary: PRIMARY_MODEL, limit: 10 }));
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.model', ?)", args: [PRIMARY_MODEL] });
  expectOk("grading: rubric-version queue (versionRegradeQueue)", await versionRegradeQueue(db, { primary: PRIMARY_MODEL, version: 99, limit: 10 }));
  expectOk("polls: hero candidates (pipeline/polls.mjs heroCandidates)", await heroCandidates(db, { known: [], now: T0 }));
  expectOk("the fallback grader's comparison pool (lib/grader/report.mjs gradedPool)", await gradedPool(db, { now: T0, ttlMs: 0 }));
  expectOk("capture refresh (lib/freshness.mjs screenshotsDue)", await screenshotsDue(db, { limit: 10, active: ACTIVE, now: T0 + 400 * 86400000 }));
  expectOk("evidence links (linksDue)", await linksDue(db, { limit: 10, active: ACTIVE, now: T0 + 400 * 86400000 }));
  expectOk("change fingerprints (dueForFingerprint)", await dueForFingerprint(db, { limit: 10, active: ACTIVE, now: T0 }));
  expectOk("Lighthouse (lighthouseDue)", await lighthouseDue(db, { limit: 10, active: ACTIVE, now: T0 }));
  expectOk("tall images (pipeline/fullpage.mjs fullPageDue)", await fullPageDue(db, { limit: 10, active: ACTIVE, now: T0 }));
  expectOk("PageSpeed prewarm (scripts/lib/prewarm.mjs prewarmQueue)", await prewarmQueue(db, { active: ACTIVE, now: T0 }));
  // Evidence and new captures: rows that would be due if healthy.
  await db.execute("UPDATE portfolios SET page_text = NULL, ai_rubric = NULL");
  expectOk("evidence (pipeline/evidence.mjs rowsNeedingEvidence)", await rowsNeedingEvidence(db, {}));
  await db.execute({ sql: "UPDATE portfolios SET status = 'error', retry_at = ?", args: [at(T0 - D).toISOString()] });
  expectOk("captures (pipeline/roster.mjs dueForCapture)", await dueForCapture(db, [{ url: ok }, { url: failing }, { url: hidden }], at(T0)));
});

test("out of AI work: the night grades a healthy new site and never a failing one", async () => {
  const { db } = await freshDb();
  const ok = "https://new-ok.example";
  const failing = "https://new-failing.example";
  await site(db, ok);
  await site(db, failing);
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_reason = 'HTTP 402: deployment paused' WHERE url = ?", args: [failing] });
  const { ctx, clock } = context(db);
  await drive(ctx, clock);
  assert.ok(await col(db, ok, "ai_rubric"), "the healthy site is graded");
  assert.equal(await col(db, failing, "ai_rubric"), null, "the failing site is not");
});

test("one shared definition: no background job writes its own health condition", () => {
  const roots = ["pipeline", "lib", "scripts", "worker", "app", "components"];
  const files = roots.flatMap(function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(mjs|ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  });
  // Where a health condition may be spelled out: the shared definitions themselves, the tier trigger and the
  // ranking input (both "on the list, not down", as LISTED_NOT_DOWN), and the health check's own writes.
  const allowed = new Set(["pipeline/roster.mjs", "lib/hidden.mjs", "lib/tiers-db.mjs", "lib/ranking/store.mjs", "pipeline/not-working.mjs", "pipeline/exclusions.mjs", "pipeline/recheck.mjs", "pipeline/health.mjs"]);
  const spelled = files.filter((f) => !allowed.has(f) && /COALESCE\(\s*[\w.]*health\s*,\s*''\s*\)\s*(!=|=|IN|NOT IN)/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(spelled, []);
  // Every query that picks sites for the AI uses ACTIVE (or is handed it).
  for (const f of ["pipeline/night.mjs", "pipeline/judge.mjs", "pipeline/compare.mjs", "pipeline/polls.mjs", "pipeline/evidence.mjs", "pipeline/rubric-history.mjs", "pipeline/content/facts.mjs", "lib/grader/report.mjs", "lib/reviews/door.mjs", "scripts/eval-rubric.mjs", "scripts/regrade-not-portfolio.mjs", "pipeline/fullpage-backfill.mjs", "pipeline/capture.mjs", "worker/freshness.ts", "scripts/prewarm-metrics.mjs"]) {
    assert.match(fs.readFileSync(f, "utf8"), /\bACTIVE\b/, f);
  }
  // The library and its tiers count a failing site (still shown) and drop a not-working one, as the trigger does.
  assert.match(fs.readFileSync("lib/tiers-store.mjs", "utf8"), /LISTED_NOT_DOWN\(\)/);
  assert.equal(LISTED_NOT_DOWN("p"), "p.delisted_at IS NULL AND COALESCE(p.health, '') != 'down'");
});
