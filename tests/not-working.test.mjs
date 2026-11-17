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
import { EXPORT_EVERY_DAYS, exportDue, markExported, planExclusions, weeklyExport } from "../pipeline/exclusions.mjs";
import { ACTIVE, AI_WORK, LISTED_NOT_DOWN, dueForCapture } from "../pipeline/roster.mjs";
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
import { ensureReviewSchema, planConfirm } from "../lib/reviews/store.mjs";
import { assignShownRanks } from "../lib/ranking/store.mjs";
import { isHiddenRow } from "../lib/hidden.mjs";

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
  return { ai: await one(AI_WORK()), capture: await one(ACTIVE()), hidden: await one(HIDDEN_WHERE), gone: await one(GONE_WHERE) };
}
const LIVE = { ai: true, capture: true, hidden: false, gone: false };
const FAILING = { ai: false, capture: false, hidden: false, gone: false };
const NOT_WORKING = { ai: false, capture: false, hidden: true, gone: true };

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

test("a site set back to live by hand (an Undo, the owner) is the nightly run's again, and starts the ladder over", async () => {
  const url = "https://undone.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "paused");
  const F = T0 + D;
  await nightly(F);
  await hourly(F + H);
  await hourly(F + D);
  assert.deepEqual(await standing(db, url), NOT_WORKING);
  // Set back to live by hand; the marks stay behind.
  await db.execute({ sql: "UPDATE portfolios SET health = 'live', health_fails = 0, health_first_fail_at = NULL WHERE url = ?", args: [url] });
  assert.equal((await dueForRecheck(db, at(F + 10 * D))).length, 0, "not the re-check's");
  const s = await nightly(F + 3 * D);
  assert.equal(s.leftToRecheck, 0, "the nightly run checks it");
  // Still failing: a first failure again, not straight back to hidden.
  assert.deepEqual(await standing(db, url), FAILING);
  assert.equal(Number((await marks(db, url)).pool_stage), pool.FAILING);
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

/** Sets a row's health as the old weekly check left it. */
const setHealth = (db, url, health, reason, first, fails) =>
  db.execute({
    sql: "UPDATE portfolios SET health = ?, health_reason = ?, health_fails = ?, health_first_fail_at = ?, health_checked_at = ? WHERE url = ?",
    args: [health, reason, fails, at(first).toISOString(), at(first).toISOString(), url],
  });

test("migration, once: rows failing for not answering when the pool ships join it from their first failure, due at once; nothing else is backdated", async () => {
  const suspect = "https://old-suspect.example";
  const down = "https://old-down.example";
  const blank = "https://old-blank.example";
  const blankSuspect = "https://old-blank-suspect.example";
  const { db, feed, w, nightly, hourly } = await setup([suspect, down, blank, blankSuspect]);
  const now = T0;
  await setHealth(db, suspect, "suspect", "HTTP 404", now - 7 * D, 1);
  await setHealth(db, down, "down", "HTTP 402: deployment paused", now - 20 * D, 3);
  await setHealth(db, blank, "down", "renders blank", now - 20 * D, 3);
  await setHealth(db, blankSuspect, "suspect", "renders blank", now - 10 * D, 1);
  // Before any run of the new code: the content-ladder "down" goes at the weekly export as before; the
  // not-answering one waits until 90 days after its first failure.
  let plan = await planExclusions({ db, excluded: [], feed, now: at(now) });
  assert.deepEqual(plan.added.map((a) => a.url), [blank]);
  assert.match(plan.held.find((h) => h.url === down).why, /leaves the list after 90 days/);

  w.mode.set(suspect, "paused");
  w.mode.set(down, "paused");
  w.mode.set(blank, "ok");
  w.mode.set(blankSuspect, "ok");
  // Night one: the adoption runs once and the nightly run leaves the adopted rows to the hourly re-check.
  let s = await nightly(now);
  assert.deepEqual(s.adopted.map((a) => a.url).sort(), [down, suspect]);
  assert.equal(s.leftToRecheck, 2);
  const ms = await marks(db, suspect);
  assert.deepEqual([Number(ms.pool_stage), ms.pool_started_at, ms.pool_next_at], [pool.FAILING, at(now - 7 * D).toISOString(), at(now).toISOString()]);
  const md = await marks(db, down);
  assert.deepEqual([Number(md.pool_stage), md.pool_since], [pool.NOT_WORKING, at(now - 20 * D).toISOString()]);
  // Hour one: the old suspect's failure counts as the hour's re-check; hour two hides it.
  await hourly(now + H);
  assert.equal(Number((await marks(db, suspect)).pool_stage), pool.RECHECKED);
  assert.deepEqual(await standing(db, suspect), FAILING);
  await hourly(now + 2 * H);
  assert.deepEqual(await standing(db, suspect), NOT_WORKING);
  // The old down site stays not working, and leaves 90 days after its first failure.
  assert.deepEqual(await standing(db, down), NOT_WORKING);
  plan = await planExclusions({ db, excluded: [], feed, now: at(now - 20 * D + 90 * D) });
  assert.ok(plan.added.some((a) => a.url === down));
  // The blank ones pass now: back.
  assert.deepEqual(await standing(db, blank), LIVE);
  assert.deepEqual(await standing(db, blankSuspect), LIVE);
  // Once: a row failing for not answering later is never adopted (it joins the ladder at its own failure).
  assert.deepEqual(await pool.adoptLegacy(db, { now: at(now + 3 * D) }), []);
});

test("a wrong-content suspect site that blips once is not backdated: the ladder starts at the new failure and the next day still confirms", async () => {
  const url = "https://spa.example";
  const { db, w, nightly, hourly } = await setup([url]);
  // The pool's one-time adoption ran already (pool.ADOPTED_KEY).
  await db.execute("INSERT INTO cache (k, v, at) VALUES ('health:pool-adopted', '{}', 0)");
  // Suspect for 10 days for a blank page (the weekly-counted ladder).
  await setHealth(db, url, "suspect", "renders blank", T0 - 10 * D, 1);
  // One HTTP 503 tonight.
  w.mode.set(url, "paused");
  await nightly(T0);
  const m = await marks(db, url);
  assert.deepEqual([Number(m.pool_stage), m.pool_started_at], [pool.FAILING, at(T0).toISOString()], "the ladder starts now, not 10 days ago");
  // Any failure an hour later is only the hour's re-check: still shown.
  await hourly(T0 + H);
  assert.deepEqual(await standing(db, url), FAILING);
  assert.equal(Number((await marks(db, url)).pool_stage), pool.RECHECKED);
  assert.equal((await marks(db, url)).pool_next_at, at(T0 + D).toISOString(), "the next day, as for any first failure");
});

test("a page with the wrong thing on a ladder site neither advances nor clears it, and the re-check backs off", async () => {
  const url = "https://now-parked.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await nightly(T0 - D);
  w.mode.set(url, "paused");
  await nightly(T0);
  await hourly(T0 + H);
  assert.equal(Number((await marks(db, url)).pool_stage), pool.RECHECKED);
  // The domain answers now, with a blank page (expired and parked, say): not answering is not what it shows.
  const blank = async (u) => (u.startsWith(url) ? response(200, "<div id=root></div>", u) : response(200, PORTFOLIO_HTML, u));
  const blankRender = async (u) => (u.startsWith(url) ? { status: 200, finalUrl: u, title: "", text: "", media: false, html: "" } : w.render(u));
  const s = await runRecheck({ db, fetchImpl: blank, render: blankRender, now: at(T0 + D), log: quiet });
  assert.equal(s.due, 1);
  const m = await marks(db, url);
  assert.equal(Number(m.pool_stage), pool.RECHECKED, "not advanced");
  assert.deepEqual(await standing(db, url), { ...FAILING, capture: true }, "not cleared, still shown; it answers, so captures may try it");
  assert.equal(await col(db, url, "health_reason"), "renders blank");
  assert.equal(m.pool_next_at, at(T0 + D + H).toISOString(), "backed off an hour");
  assert.ok(m.unknown_since, "its time counts toward the owner's alert");
});

// ---------------------------------------------------------------------------
// Out of the AI's work: every query that picks sites for it

test("per consumer: the AI's queues take only healthy sites; the free jobs (captures and measurements) also take a site suspect for what its page shows, never one that does not answer", async () => {
  const { db } = await freshDb();
  await ensureFreshnessSchema(db);
  const ok = "https://healthy.example";
  const blank = "https://blank-suspect.example";
  const failing = "https://failing.example";
  const hidden = "https://notworking.example";
  const all = [ok, blank, failing, hidden];
  const oldGrade = { ...answer(true), tier: "A", model: "old-model", rubric_version: 0, judged_at: "2026-01-01T00:00:00Z" };
  for (const u of all) await site(db, u, { rubric: oldGrade });
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_reason = 'renders blank' WHERE url = ?", args: [blank] });
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_reason = 'HTTP 402: deployment paused' WHERE url = ?", args: [failing] });
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'HTTP 402: deployment paused' WHERE url = ?", args: [hidden] });
  const only = (rows) => rows.map((r) => String(typeof r === "string" ? r : r.url)).filter((u) => all.includes(u)).sort();
  const ai = (name, rows) => assert.deepEqual(only(rows), [ok], `AI_WORK: ${name}`);
  const free = (name, rows) => assert.deepEqual(only(rows), [blank, ok].sort(), `ACTIVE: ${name}`);

  // AI_WORK: grading, comparisons, polls, blog facts, the grader's pool, evidence for a grade.
  ai("re-grade queue (pipeline/rubric-history.mjs regradeQueue)", await regradeQueue(db, { primary: PRIMARY_MODEL, limit: 10 }));
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.model', ?)", args: [PRIMARY_MODEL] });
  ai("rubric-version queue (versionRegradeQueue)", await versionRegradeQueue(db, { primary: PRIMARY_MODEL, version: 99, limit: 10 }));
  ai("poll hero candidates (pipeline/polls.mjs heroCandidates)", await heroCandidates(db, { known: [], now: T0 }));
  ai("the fallback grader's comparison pool (lib/grader/report.mjs gradedPool)", await gradedPool(db, { now: T0, ttlMs: 0 }));
  // ACTIVE: the free jobs.
  free("screenshot refresh (lib/freshness.mjs screenshotsDue, via pipeline/capture.mjs)", await screenshotsDue(db, { limit: 10, active: ACTIVE, now: T0 + 400 * 86400000 }));
  free("link checks (linksDue, via pipeline/evidence.mjs)", await linksDue(db, { limit: 10, active: ACTIVE, now: T0 + 400 * 86400000 }));
  free("change fingerprints (dueForFingerprint, via worker/freshness.ts)", await dueForFingerprint(db, { limit: 10, active: ACTIVE, now: T0 }));
  free("Lighthouse (lighthouseDue)", await lighthouseDue(db, { limit: 10, active: ACTIVE, now: T0 }));
  free("tall images (pipeline/fullpage.mjs fullPageDue)", await fullPageDue(db, { limit: 10, active: ACTIVE, now: T0 }));
  free("PageSpeed prewarm (scripts/lib/prewarm.mjs prewarmQueue)", await prewarmQueue(db, { active: ACTIVE, now: T0 }));
  // Evidence for grading, and captures with their retries: rows that would be due.
  await db.execute("UPDATE portfolios SET page_text = NULL, ai_rubric = NULL");
  ai("page evidence (pipeline/evidence.mjs rowsNeedingEvidence)", await rowsNeedingEvidence(db, {}));
  // Each failing row as the health check left it (checked at T0), with a capture retry from before that.
  await db.execute({ sql: "UPDATE portfolios SET status = 'error', retry_at = ?, health_checked_at = ?", args: [at(T0 - D).toISOString(), at(T0).toISOString()] });
  free("captures and their retries (pipeline/roster.mjs dueForCapture)", await dueForCapture(db, all.map((url) => ({ url })), at(T0)));
});

test("captures: a blocked first capture keeps its retries while suspect, and the review queue's confirm of a hidden site queues a capture that runs", async () => {
  const { db } = await freshDb();
  const blocked = "https://gated.example";
  await site(db, blocked, { status: "error", reason: "capture blocked: still a gate or loader after the click-through", captured: false });
  const feed = [{ url: blocked, name: "Ann Lee" }, ...fillers];
  for (const f of fillers) await site(db, f.url);
  // The check sees the page up, but its capture was blocked: a failed check with the capture's reason.
  const fetchImpl = async (u) => response(200, PORTFOLIO_HTML, u);
  await health.runHealthCheck({ db, feed, fetchImpl, render: async (u) => goodPage(u), now: at(T0), log: quiet });
  assert.equal(await col(db, blocked, "health"), "suspect");
  await db.execute({ sql: "UPDATE portfolios SET retry_at = ? WHERE url = ?", args: [at(T0 + H).toISOString(), blocked] });
  assert.deepEqual((await dueForCapture(db, [{ url: blocked }], at(T0 + 2 * H))).map((e) => e.url), [blocked], "its capture retry still runs");

  // A not-working site the owner confirms as a portfolio on /admin/review: the queue's own statements.
  const url = "https://confirmed.example";
  await site(db, url);
  await setHealth(db, url, "down", "HTTP 402: deployment paused", T0 - 3 * D, 3);
  await db.execute({ sql: "UPDATE portfolios SET status = 'error' WHERE url = ?", args: [url] });
  const row = (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const { stmts } = planConfirm({ url, proposed: "keep", reason: "a portfolio", decidedBy: "admin:owner", batch: null }, row, { onFeed: true, now: at(T0) });
  await db.batch(stmts, "write");
  assert.equal(await col(db, url, "health"), "suspect");
  assert.deepEqual((await dueForCapture(db, [{ url }], at(T0 + H))).map((e) => e.url), [url], "the capture it queued runs");
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
  // Every query that picks sites for the AI uses AI_WORK, and never ACTIVE.
  for (const f of ["pipeline/night.mjs", "pipeline/judge.mjs", "pipeline/compare.mjs", "pipeline/polls.mjs", "pipeline/rubric-history.mjs", "pipeline/content/facts.mjs", "lib/grader/report.mjs", "scripts/eval-rubric.mjs", "scripts/regrade-not-portfolio.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /\$\{AI_WORK\(/, f);
    assert.doesNotMatch(src, /\$\{ACTIVE\(/, f);
  }
  // Evidence: the page text for a grade is AI work, its link checks are not.
  assert.match(fs.readFileSync("pipeline/evidence.mjs", "utf8"), /\$\{AI_WORK\(\)\}[\s\S]*active: ACTIVE/);
  // Every free job (captures, refresh, measurements, the door's review rows) uses ACTIVE, or is handed it.
  for (const f of ["pipeline/roster.mjs", "pipeline/capture.mjs", "pipeline/fullpage-backfill.mjs", "worker/freshness.ts", "scripts/prewarm-metrics.mjs", "lib/reviews/door.mjs"]) {
    assert.match(fs.readFileSync(f, "utf8"), /\bACTIVE\b/, f);
  }
  // The library and its tiers count a failing site (still shown) and drop a not-working one, as the trigger does.
  assert.match(fs.readFileSync("lib/tiers-store.mjs", "utf8"), /LISTED_NOT_DOWN\(\)/);
  assert.equal(LISTED_NOT_DOWN("p"), "p.delisted_at IS NULL AND COALESCE(p.health, '') != 'down'");
});

test("the SQL twins agree with the code: not answering, and the hidden rule", async () => {
  const { db } = await freshDb();
  const reasons = ["HTTP 402: deployment paused", "HTTP 503", "does not load (x)", "DNS resolution failed", "connect timeout (x)", "TLS error", "timeout", "connection dropped (ECONNRESET)", "renders blank", 'parking phrase: "x"', "duplicate of y", "", null, "http 500", "HTTPS"];
  for (const r of reasons) {
    const sql = Number((await db.execute({ sql: `SELECT ${pool.NOT_ANSWERING_SQL("?1")} AS v`, args: [r] })).rows[0].v) === 1;
    assert.equal(sql, pool.notAnswering(r), String(r));
  }
  for (const status of ["live", "pending", "error", "dead", "parked", null]) {
    for (const h of [null, "live", "suspect", "down"]) {
      const sql = Number((await db.execute({ sql: `SELECT (${HIDDEN_WHERE.replaceAll("health", "?2").replaceAll("status", "?1")}) AS v`, args: [status, h] })).rows[0].v) === 1;
      assert.equal(sql, isHiddenRow({ status, health: h }), `${status}/${h}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The code review of #251 (findings numbered as in the review)

/** Puts `urls` on the ladder at stage 1, failing since `F`, so the hour's re-check is due at F + 1 h. */
async function failingSince(nightly, w, urls, F) {
  for (const u of urls) w.mode.set(u, "paused");
  await nightly(F);
}

test("review 1: an hour with 30 due sites that all still fail records every one (the re-check's guard is its control sites, not the failure share)", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `https://host-shut-down-${i}.example`);
  const { db, w, hourly } = await setup(many);
  const night = (now) => health.runHealthCheck({ db, feed: [...many.map((url) => ({ url, name: "Ann Lee" })), ...fillers, ...Array.from({ length: 70 }, (_, i) => ({ url: `https://more-${i}.dev`, name: "Ann Lee" }))], fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  // A night where 30 of 130 sites fail (a free host shutting down): under the nightly run's 30% guard.
  await failingSince(night, w, many, T0);
  for (const u of many) assert.equal(Number((await marks(db, u)).pool_stage), pool.FAILING, u);
  const s = await hourly(T0 + H);
  assert.equal(s.aborted, false, s.message);
  assert.equal(s.due, 30);
  for (const u of many) assert.equal(Number((await marks(db, u)).pool_stage), pool.RECHECKED, u);
});

test("review 3: a re-check that keeps not telling backs off (1, 2, 4 ... hours, then daily) and goes to the owner after 28 days", async () => {
  const url = "https://never-sure.example";
  const { db, w, nightly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  w.mode.set(url, "unsure");
  const hour = (t) => runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(t), log: quiet });
  let t = T0 + H;
  const waits = [];
  for (let i = 0; i < 8; i++) {
    const s = await hour(t);
    assert.equal(s.due, 1, `re-check ${i}`);
    const next = Date.parse(String((await marks(db, url)).pool_next_at));
    waits.push((next - t) / H);
    // An hour before it is due, nothing is.
    assert.equal((await hour(next - H)).due, 0);
    t = next;
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 24, 24, 24]);
  assert.deepEqual(await standing(db, url), FAILING, "never hidden, never cleared, on a check that cannot tell");
  // The owner hears of it after 28 days of not telling, though the nightly run never looks at it.
  const until = T0 + H + 29 * D;
  while (t < until) {
    await hour(t);
    t = Date.parse(String((await marks(db, url)).pool_next_at));
  }
  const alert = (await db.execute({ sql: "SELECT detail FROM owner_alerts WHERE key = ? AND cleared_at IS NULL", args: [health.UNKNOWN_LADDER_ALERT_KEY] })).rows[0];
  assert.ok(alert && String(alert.detail).includes(url));
  // It answers: the alert clears.
  w.mode.set(url, "ok");
  await hour(t);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM owner_alerts WHERE key = ? AND cleared_at IS NULL", args: [health.UNKNOWN_LADDER_ALERT_KEY] })).rows[0].n, 0);
});

test("review 5: marks a foreign writer leaves behind never steer the site (the review queue's confirm and remove, an Undo, a relist)", async () => {
  const url = "https://foreign.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  await hourly(T0 + H);
  await hourly(T0 + D);
  assert.equal(await col(db, url, "health"), "down");
  const onLadder = async () => (await db.execute(pool.ON_LADDER_SQL)).rows.map((r) => String(r.url)).includes(url);
  assert.equal(await onLadder(), true);
  const rowOf = async () => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const before = await rowOf();

  // The owner confirms it as a portfolio on /admin/review (lib/reviews/store.mjs planConfirm: health 'suspect').
  const confirm = planConfirm({ url, proposed: "keep", reason: "a portfolio", decidedBy: "admin:owner", batch: null }, before, { onFeed: true, now: at(T0 + D + H) });
  await db.batch(confirm.stmts, "write");
  assert.equal(await onLadder(), false, "the stale monthly schedule no longer holds it");
  const s = await nightly(T0 + 2 * D);
  assert.equal(s.leftToRecheck, 0, "the nightly run checks it");
  const m = await marks(db, url);
  assert.deepEqual([Number(m.pool_stage), await col(db, url, "health")], [pool.FAILING, "suspect"], "a failure starts over at stage 1, not straight back to hidden");

  // An Undo that puts the row back exactly as it was: the marks describe it again.
  await db.execute({ sql: "UPDATE portfolios SET health = ?, health_checked_at = ? WHERE url = ?", args: [String(before.health), String(before.health_checked_at), url] });
  await db.execute({ sql: "UPDATE health_marks SET pool_health = ?, pool_checked_at = ?, pool_stage = 3 WHERE url = ?", args: [String(before.health), String(before.health_checked_at), url] });
  assert.equal(await onLadder(), true);

  // The review queue removes it (health 'down' with a new health_checked_at): not the ladder's any more.
  const removeRow = await rowOf();
  const remove = planConfirm({ url, proposed: "remove", reason: "not a portfolio", decidedBy: "admin:owner", batch: null }, removeRow, { onFeed: true, now: at(T0 + 3 * D) });
  await db.batch(remove.stmts, "write");
  assert.equal(await onLadder(), false);
  assert.equal((await dueForRecheck(db, at(T0 + 400 * D))).length, 0);
});

test("review 5: a removed site that passes its monthly re-check is due at once when the list takes it back", async () => {
  const url = "https://back-after-90.example";
  const { db, feed, w, nightly, hourly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  await hourly(T0 + H);
  await hourly(T0 + D);
  const S = T0 + D;
  // Day 90: the weekly export takes it off the list; the roster sync delists it.
  let ex = await weeklyExport({ db, excluded: [], feed, now: at(S + 90 * D), answers: async () => false });
  assert.deepEqual(ex.plan.added.map((a) => a.url), [url]);
  await db.execute({ sql: "UPDATE portfolios SET delisted_at = ? WHERE url = ?", args: [at(S + 90 * D).toISOString(), url] });
  // Main carries it a few days later.
  const landedFiles = ex.files;
  await weeklyExport({ db, excluded: landedFiles.excluded, feed: landedFiles.feed, now: at(S + 92 * D), answers: async () => false });
  // A month on, its re-check passes: it leaves the exclusion list, and its marks are due now.
  w.mode.set(url, "ok");
  const later = S + 125 * D;
  const entry = landedFiles.excluded.find((e) => e.url === url);
  const excluded = [{ ...entry, removed: at(S + 90 * D).toISOString().slice(0, 10) }];
  ex = await weeklyExport({ db, excluded, feed: landedFiles.feed, now: at(later), answers: async (u) => u === url });
  assert.deepEqual(ex.plan.back, [url]);
  assert.equal((await marks(db, url)).pool_next_at, at(later).toISOString());
  // The daily sync lists it again: the next hour's re-check brings it back.
  await db.execute({ sql: "UPDATE portfolios SET delisted_at = NULL WHERE url = ?", args: [url] });
  const s = await hourly(later + H);
  assert.deepEqual(s.returned.map((r) => r.url), [url]);
  assert.deepEqual(await standing(db, url), LIVE);
});

test("review 6: a profile the check takes away is marked for the edge purge when written, whatever the hour, and stays marked until a purge works", async () => {
  const url = "https://purge-me.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  await hourly(T0 + H);
  assert.equal(Number((await marks(db, url)).purge_pending), 0, "still shown: nothing to purge");
  // Hidden by a re-check that started at :43 and wrote at :52 (between two hourly purges).
  await hourly(T0 + D + 43 * 60000);
  assert.equal(Number((await marks(db, url)).purge_pending), 1);
  let asked = [];
  const refused = await pool.purgeGoneProfiles(db, { purge: async (urls) => ((asked = urls), false) });
  assert.deepEqual([refused.failed, asked], [[url], [url]]);
  assert.equal(Number((await marks(db, url)).purge_pending), 1, "a failed purge is tried again");
  const done = await pool.purgeGoneProfiles(db, { purge: async () => true });
  assert.deepEqual(done.purged, [url]);
  assert.equal(Number((await marks(db, url)).purge_pending), 0);
  assert.deepEqual((await pool.purgeGoneProfiles(db, { purge: async () => assert.fail("nothing left to purge") })).purged, []);
  // The Worker's hourly purge calls it (worker/index.ts), not a time window.
  const worker = fs.readFileSync("worker/index.ts", "utf8");
  assert.match(worker, /purgeGoneProfiles\(database\(\)/);
  assert.doesNotMatch(worker, /health_checked_at > \?/);
});

test("review 7: the boards' shown ranks follow any change of the hidden rule, a failed capture's first failed check included", async () => {
  const shown = "https://board-a.example";
  const capt = "https://board-b.example";
  const { db, w } = await setup([shown, capt]);
  const feed = [shown, capt].map((url) => ({ url, name: "Ann Lee" }));
  // On the board: a failed capture whose health check passed (status error, health live: shown).
  await db.execute({ sql: "UPDATE portfolios SET status = 'error', reason = 'HTTP 500', health = 'live' WHERE url = ?", args: [capt] });
  for (const [i, url] of [shown, capt].entries()) {
    await db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES ('merged', ?, ?, 30, 2, 'confident')", args: [url, i + 1] });
  }
  await assignShownRanks(db);
  const ranks = async () => Object.fromEntries((await db.execute("SELECT url, shown_rank FROM site_ratings WHERE view = 'merged'")).rows.map((r) => [String(r.url), r.shown_rank == null ? null : Number(r.shown_rank)]));
  assert.deepEqual(await ranks(), { [shown]: 1, [capt]: 2 });
  // Its first failed check (suspect) hides it (status error, health not live): the board closes up at once.
  w.mode.set(capt, "paused");
  await health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(T0), log: quiet });
  assert.equal(await col(db, capt, "health"), "suspect");
  assert.deepEqual(await ranks(), { [shown]: 1, [capt]: null });
  // It passes: shown again, at once.
  w.mode.set(capt, "ok");
  await runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(T0 + H), controls: 0, log: quiet });
  assert.deepEqual(await ranks(), { [shown]: 1, [capt]: 2 });
});

test("review 8: an export planned on Monday is in Tuesday's files too, until it lands; only then is it done", async () => {
  const url = "https://ninety.example";
  const { db, feed, w, nightly, hourly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  await hourly(T0 + H);
  await hourly(T0 + D);
  const monday = T0 + D + 91 * D;
  const main = { excluded: [{ url: "https://old.example", kind: "owner_request", reason: "owner request", removed: "2026-01-01" }], feed };
  const mon = await weeklyExport({ db, ...main, now: at(monday), answers: async () => false });
  assert.equal(mon.planned, true);
  assert.ok(mon.files.excluded.some((e) => e.url === url));
  assert.ok(!mon.files.feed.some((p) => p.url === url));
  // Tuesday: the pull request has not merged; an owner removal rewrites its branch from main. The export is applied again.
  const tue = await weeklyExport({ db, ...main, now: at(monday + D), answers: async () => assert.fail("not planned again") });
  assert.equal(tue.planned, false);
  assert.ok(tue.files.excluded.some((e) => e.url === url), "Monday's exclusion is still in the files");
  assert.ok(!tue.files.feed.some((p) => p.url === url));
  assert.equal(await exportDue(db, at(monday + 7 * D)), false, "not done while it has not landed");
  // Wednesday: main carries it. Done, and the next plan comes six days after.
  const landed = { excluded: tue.files.excluded, feed: tue.files.feed };
  const wed = await weeklyExport({ db, ...landed, now: at(monday + 2 * D), answers: async () => false });
  assert.deepEqual([wed.landed, wed.files], [true, null]);
  assert.equal(await exportDue(db, at(monday + 5 * D)), false);
  assert.equal(await exportDue(db, at(monday + EXPORT_EVERY_DAYS * D)), true);
});

test("review 9: the hourly re-check reads only its own sites' rows, not the whole list", async () => {
  const url = "https://only-me.example";
  const { db, w, nightly } = await setup([url]);
  await failingSince(nightly, w, [url], T0);
  const reads = [];
  const spy = new Proxy(db, {
    get(target, prop) {
      if (prop !== "execute") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
      return async (q) => {
        const sql = typeof q === "string" ? q : q.sql;
        if (/AS decided_removal/.test(sql)) reads.push(sql);
        return target.execute(q);
      };
    },
  });
  const s = await runRecheck({ db: spy, fetchImpl: w.fetchImpl, render: w.render, now: at(T0 + H), log: quiet });
  assert.equal(s.due, 1);
  assert.equal(reads.length, 1);
  assert.match(reads[0], /p\.url IN \(\?\)/);
});

test("dry runs write nothing, work on a database from before this release, and say what would change", async () => {
  const suspect = "https://dry-suspect.example";
  const fresh = "https://dry-fresh.example";
  const { db } = await freshDb();
  for (const f of fillers) await site(db, f.url);
  for (const u of [suspect, fresh]) await site(db, u);
  await setHealth(db, suspect, "suspect", "HTTP 404", T0 - 7 * D, 1);
  // A database before this release: the review queue's table (on main already), and no health_marks table at all.
  await ensureReviewSchema(db);
  assert.equal((await pool.columnsOf(db, "health_marks")).size, 0);
  const feed = [suspect, fresh].map((url) => ({ url, name: "Ann Lee" })).concat(fillers);
  const w = world();
  w.mode.set(suspect, "paused");
  w.mode.set(fresh, "paused");
  const dump = async () => JSON.stringify((await db.execute("SELECT * FROM portfolios ORDER BY url")).rows) + JSON.stringify((await db.execute("SELECT * FROM cache ORDER BY k")).rows);
  const before = await dump();
  const night = await health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(T0), log: quiet, dryRun: true });
  assert.equal(night.dryRun, true);
  assert.deepEqual(night.adopted.map((a) => a.url), [suspect]);
  assert.deepEqual(night.changes.map((c) => [c.url, c.from, c.to, c.stage]), [[fresh, null, "suspect", 1]]);
  assert.match(health.healthSummary(night), /dry run: nothing written[\s\S]*Would change \(1\)/);
  const hour = await runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(T0 + H), log: quiet, dryRun: true });
  assert.equal(hour.due, 1, "the adopted row, due at once");
  assert.deepEqual(hour.changes.map((c) => [c.url, c.to, c.stage]), [[suspect, "suspect", pool.RECHECKED]]);
  assert.match(recheckSummary(hour), /dry run: nothing written/);
  assert.equal(await dump(), before, "nothing written");
  assert.equal((await pool.columnsOf(db, "health_marks")).size, 0, "no schema change");
  // The export, dry: planned and not kept.
  const ex = await weeklyExport({ db, excluded: [], feed, now: at(T0), dryRun: true, answers: async () => false });
  assert.equal(ex.planned, true);
  assert.equal(await dump(), before);
});
