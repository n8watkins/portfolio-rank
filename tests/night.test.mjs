// The end-of-day run (pipeline/night.mjs), offline: a throwaway database, a
// simulated clock (sleeping moves it forward, no real waiting) and a mocked
// Gemini. `drive` does what the Cloudflare Workflow does (worker/night.ts):
// start, plan, one batch per step, pauses, finish.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { DEFAULT_PLAN, budgetPlan } from "../pipeline/budget.mjs";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { ensureNightSchema, finishNight, planNight, recentNights, recordItemFailure, runBatch, startNight } from "../pipeline/night.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import feed from "../data/feed.json" with { type: "json" };

const answer = (over = {}) => ({
  is_portfolio: true,
  tier: "B",
  ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 3, note: "fine" }])),
  ...over,
});
const ok = (json = answer()) => ({ status: 200, json });
const busy = { status: 503, text: "overloaded" };
const dailyQuota429 = {
  status: 429,
  text: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }),
};
const facts = JSON.stringify({ source: "http", measured_at: "2026-11-01T00:00:00Z", github: true });
const urls = feed.map((p) => p.url);
// 20:30 Pacific (standard time) on 2026-11-10.
const T0 = Date.parse("2026-11-11T04:30:00Z");

async function setup({ fresh = 0, changed = 0, old31 = 0, noEvidence = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  let i = 0;
  const add = async (kind, grade) => {
    const url = urls[i];
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, page_text, facts, meta)
            VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?)`,
      args: [url, `Person ${i}`, `k${i}`, `2026-11-0${1 + (i % 9)} 00:00:00`, grade ? JSON.stringify(grade) : null, kind === "noEvidence" ? null : "Hi, I build things.", kind === "noEvidence" ? null : facts, JSON.stringify({ motion: false })],
    });
    i++;
    return url;
  };
  const made = { fresh: [], changed: [], old31: [], noEvidence: [] };
  for (let n = 0; n < fresh; n++) made.fresh.push(await add("fresh", null));
  for (let n = 0; n < changed; n++) {
    const url = await add("changed", { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, rubric_version: 2, judged_at: "2026-11-01T00:00:00.000Z" });
    await db.execute({ sql: "INSERT INTO rating_resets (url, at, reason) VALUES (?, '2026-11-09T00:00:00.000Z', 'page_changed')", args: [url] });
    made.changed.push(url);
  }
  for (let n = 0; n < old31; n++) made.old31.push(await add("old31", { tier: "B", is_portfolio: true, model: BACKUP_MODEL, judged_at: `2026-10-0${1 + n}T00:00:00.000Z` }));
  for (let n = 0; n < noEvidence; n++) made.noEvidence.push(await add("noEvidence", null));
  return { db, made };
}

// A Gemini stand-in: answers from `steps` in order (the last repeats), or
// from a function of the call number. Records every call.
function mockGemini(steps, { onCall } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const n = calls.length;
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    await onCall?.(n);
    const step = typeof steps === "function" ? steps(n) : steps[Math.min(n, steps.length - 1)];
    if (step.status !== 200) return new Response(step.text ?? "", { status: step.status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(step.json) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

function context(db, { start = T0, budget = {}, quota = 500, rpm = 8, gemini, rankingV2 = false, rubricRegrade = false, rankingBudget } = {}) {
  const clock = { t: start };
  const lines = [];
  // Re-grades are off by default (DEFAULT_PLAN); these tests turn them on
  // unless a test sets the regrade stage itself.
  const plan = budgetPlan(JSON.stringify({ ...budget, stages: { regrade: { cap: 300 }, ...budget.stages } }));
  return {
    clock,
    lines,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan,
      quota: { [PRIMARY_MODEL]: quota, [BACKUP_MODEL]: 500 },
      rpm,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (l) => lines.push(l),
      fetchImpl: gemini.fetchImpl,
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      flags: { rankingV2, rubricRegrade, ranking: { ...rankingConfig({ RANKING_V2: rankingV2 ? "true" : "" }), ...(rankingBudget ? { budget: rankingBudget } : {}) } },
      runId: "test",
    },
  };
}

// The Workflow's loop, with the free checks done.
async function drive(ctx, clock, { checksMinutes = 0, maxSteps = 500 } = {}) {
  let state = await startNight(ctx);
  if (state.skip) return { skipped: state };
  clock.t += checksMinutes * 60000;
  state = await planNight(ctx, state);
  let steps = 0;
  while (!state.done && steps++ < maxSteps) {
    const r = await runBatch(ctx, state);
    state = r.state;
    if (r.pauseMs) clock.t += r.pauseMs;
  }
  assert.ok(state.done, "the run ends");
  const done = await finishNight(ctx, state);
  return { state, ...done };
}

const jobsInOrder = async (db) => (await db.execute("SELECT job FROM gemini_requests ORDER BY id")).rows.map((r) => String(r.job));
const requestTimes = async (db) => (await db.execute("SELECT at FROM gemini_requests ORDER BY id")).rows.map((r) => Date.parse(String(r.at)));

test("stages run in priority order: new sites, then changed sites, then re-grades; off stages say why", async () => {
  const { db, made } = await setup({ fresh: 3, changed: 2, old31: 2, noEvidence: 1 });
  const gemini = mockGemini([ok()]);
  const { ctx, clock } = context(db, { gemini });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "complete");
  const jobs = await jobsInOrder(db);
  // Content writes the weekly polls (one request: nothing was scheduled ahead).
  assert.deepEqual(jobs, ["grade-new", "grade-new", "grade-new", "grade-changed", "grade-changed", "content", "regrade", "regrade"]);
  // Graded on 3.5, the changed and 3.1 grades kept in history.
  const graded = (await db.execute("SELECT url, json_extract(ai_rubric, '$.model') AS m FROM portfolios WHERE ai_rubric IS NOT NULL")).rows;
  assert.ok(graded.every((g) => g.m === PRIMARY_MODEL));
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM rubric_history")).rows[0].n), 4);
  // A row without page text and facts waits for the Actions evidence step.
  assert.equal((await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [made.noEvidence[0]] })).rows[0].ai_rubric, null);
  // A changed site graded tonight is not "changed" any more.
  const again = await planNight(ctx, { ...r.state, estimate: null });
  assert.equal(again.estimate.perStage.grade_changed, 0);

  const byKey = Object.fromEntries(r.summary.stages.map((s) => [s.key, s]));
  assert.equal(byKey.compare.label, "AI ranking comparisons");
  assert.match(byKey.compare.result, /off: RANKING_V2 is not "true"/);
  assert.equal(byKey.content.label, "Content");
  assert.equal(byKey.content.requests, 1);
  assert.equal(byKey.grade_new.done, 3);
  assert.match(r.markdown, /\| AI ranking comparisons \| 0 \|/);
  assert.match(r.markdown, /Human votes \(the face-off\) use no Gemini and are never scheduled/);
  // Estimate at the start and the actual at the end.
  assert.equal(r.summary.estimate.requests, 8);
  assert.equal(r.summary.estimate.minutes, 1);
  assert.equal(r.summary.actual.requests, 8);
  assert.match(r.markdown, /Estimated: 8 request\(s\), about 1 min at 8\/min\. Actual: 8 request\(s\)/);
});

test("requests are paced evenly across batches", async () => {
  const { db } = await setup({ fresh: 5 });
  const { ctx, clock } = context(db, { gemini: mockGemini([ok()]), budget: { batch: 2 }, rpm: 6 });
  await drive(ctx, clock);
  const times = await requestTimes(db);
  assert.equal(times.length, 6); // 5 grades and the weekly polls
  for (let k = 1; k < times.length; k++) assert.ok(times[k] - times[k - 1] >= 10000, `request ${k} waits the 10 s gap`);
});

test("caps: a stage stops at its request cap and the next one starts", async () => {
  const { db } = await setup({ fresh: 5, old31: 2 });
  const { ctx, clock } = context(db, { gemini: mockGemini([ok()]), budget: { stages: { grade_new: { cap: 2 } } } });
  const r = await drive(ctx, clock);
  assert.deepEqual(await jobsInOrder(db), ["grade-new", "grade-new", "content", "regrade", "regrade"]);
  assert.match(r.summary.stages.find((s) => s.key === "grade_new").result, /cap reached \(2 requests today\)/);
});

test("re-grades are off by default until rubric v3: the night spends nothing on them", async () => {
  assert.equal(DEFAULT_PLAN.stages.regrade.cap, 0);
  assert.equal(budgetPlan(undefined).stages.regrade.cap, 0, "no GEMINI_BUDGET: re-grades stay off");
  const { db } = await setup({ fresh: 2, old31: 2 });
  const { ctx, clock } = context(db, { gemini: mockGemini([ok()]), budget: { stages: { regrade: DEFAULT_PLAN.stages.regrade } } });
  const r = await drive(ctx, clock);
  assert.deepEqual(await jobsInOrder(db), ["grade-new", "grade-new", "content"]);
  const regrade = r.summary.stages.find((s) => s.key === "regrade");
  assert.equal(regrade.requests ?? 0, 0);
  assert.equal(r.summary.estimate.perStage.regrade ?? 0, 0, "the estimate plans none");
});

test("the reserve is never spent, and it grows with people's demand", async () => {
  const { db } = await setup({ fresh: 10 });
  // People asked for 6 grades 30 minutes ago: the reserve is max(2, 2 x 6) = 12.
  const people = createRequestLog({ db, job: "people-grade" });
  for (let k = 0; k < 6; k++) await people.record({ at: new Date(T0 - 30 * 60000).toISOString(), model: PRIMARY_MODEL, status: 200 });
  const { ctx, clock } = context(db, { gemini: mockGemini([ok()]), quota: 22, budget: { reserve: 2 } });
  const r = await drive(ctx, clock);
  // 22 - 6 used - 12 reserve = 4.
  assert.equal((await jobsInOrder(db)).filter((j) => j === "grade-new").length, 4);
  assert.equal(r.status, "stopped");
  assert.match(r.summary.stopped, /only the reserve for people is left/);
});

test("people preempt: a batch that sees people grading pauses, and resumes once they are done", async () => {
  const { db } = await setup({ fresh: 6 });
  let people = null;
  const gemini = mockGemini([ok()], {
    // While the background's 2nd request is answered, a person asks for a grade.
    onCall: async (n) => {
      if (n === 1) await people.record({ at: new Date(clockRef.t).toISOString(), model: PRIMARY_MODEL, status: 200 });
    },
  });
  const { ctx, clock } = context(db, { gemini, budget: { batch: 2 } });
  const clockRef = clock;
  people = createRequestLog({ db, job: "people-grade" });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "complete");
  assert.ok(r.state.pauses >= 1, "the background paused");
  // Nothing was sent in the 10 minutes after the person's request.
  const personAt = Date.parse(String((await db.execute("SELECT at FROM gemini_requests WHERE job = 'people-grade'")).rows[0].at));
  const after = (await db.execute("SELECT at FROM gemini_requests WHERE job = 'grade-new'")).rows.map((x) => Date.parse(String(x.at))).filter((t) => t > personAt);
  assert.ok(after.length >= 1);
  assert.ok(after.every((t) => t - personAt >= 10 * 60000), "background waits until people are done");
  assert.equal(r.summary.actual.pauses, r.state.pauses);
});

test("each stage has a wall-clock cap, and everything stops 30 minutes before the quota resets", async () => {
  const { db } = await setup({ fresh: 30, old31: 30 });
  // 1 request a minute; new grades get 5 minutes; the run starts at 23:15 Pacific.
  const start = Date.parse("2026-11-11T07:15:00Z");
  const { ctx, clock } = context(db, { start, rpm: 1, gemini: mockGemini([ok()]), budget: { stages: { grade_new: { cap: 300, minutes: 5 } } } });
  const r = await drive(ctx, clock);
  const byKey = Object.fromEntries(r.summary.stages.map((s) => [s.key, s]));
  assert.match(byKey.grade_new.result, /time cap reached/);
  assert.ok(byKey.grade_new.requests <= 6);
  assert.equal(r.status, "stopped");
  assert.match(r.summary.stopped, /hard stop 30 minutes before the quota resets \(23:30 Pacific\)/);
  const hardStop = Date.parse("2026-11-11T07:30:00Z");
  assert.ok((await requestTimes(db)).every((t) => t < hardStop), "no request after 23:30 Pacific");
});

test("the hard stop follows daylight time: 23:30 PDT in summer", async () => {
  const { db } = await setup({ fresh: 40 });
  const start = Date.parse("2026-07-16T06:20:00Z"); // 23:20 PDT
  const { ctx, clock } = context(db, { start, rpm: 1, gemini: mockGemini([ok()]) });
  const r = await drive(ctx, clock);
  assert.match(r.summary.stopped, /23:30 Pacific/);
  assert.ok((await requestTimes(db)).every((t) => t < Date.parse("2026-07-16T06:30:00Z")));
});

test("a busy 3.5: bounded retries per request and per night, then the run stops as waiting, not failed", async () => {
  const { db } = await setup({ fresh: 10 });
  const gemini = mockGemini([busy]);
  const { ctx, clock } = context(db, { gemini, budget: { retryBudget: 5 } });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "stopped");
  assert.match(r.summary.stopped, /retry budget \(5 retries\) is used up/);
  assert.equal(r.summary.actual.retries, 5);
  // First call: 1 + 3 retries, then GeminiUnavailableError; second call: 1 + 2 retries hits the budget.
  assert.equal(gemini.calls.length, 7);
  // A busy model is not the site's fault: nothing is counted towards parking.
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM night_item_failures")).rows[0].n), 0);
});

test("a failed or stopped run never restarts itself the same night", async () => {
  const { db } = await setup({ fresh: 3 });
  const { ctx, clock } = context(db, { gemini: mockGemini([busy]), budget: { retryBudget: 1 } });
  await drive(ctx, clock);
  clock.t += 30 * 60000;
  const second = await drive(ctx, clock);
  assert.match(second.skipped.reason, /already started .* never restarts the same night/);
  const nights = await recentNights(db);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].status, "stopped");
  assert.equal(nights[0].summary.stopped.includes("retry budget"), true);
});

test("circuit breaker: 5 failures in a row stop that stage for the night; the next stage still runs", async () => {
  const { db } = await setup({ fresh: 8, old31: 2 });
  // New grades get malformed answers; re-grades get good ones.
  const gemini = mockGemini((n) => (n < 5 ? ok({ nonsense: true }) : ok()));
  const { ctx, clock } = context(db, { gemini });
  const r = await drive(ctx, clock);
  const byKey = Object.fromEntries(r.summary.stages.map((s) => [s.key, s]));
  assert.match(byKey.grade_new.result, /circuit breaker: 5 failures in a row/);
  assert.equal(byKey.grade_new.failed, 5);
  assert.equal(byKey.regrade.done, 2);
  assert.equal(r.status, "complete");
});

test("an item failing 3 nights in a row is parked, listed, and not tried again", async () => {
  const { db, made } = await setup({ fresh: 2 });
  const bad = made.fresh[0];
  // Every request about the bad site gets a malformed answer.
  const night = async (start) => {
    const g = mockGemini([ok()]);
    const { ctx, clock } = context(db, { start, gemini: g });
    const malformed = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"tier":"Z"}' }] } }] });
    ctx.fetchImpl = async (url, init) => (String(init.body).includes(bad) ? new Response(malformed, { status: 200 }) : g.fetchImpl(url, init));
    // Re-open the good site each night so there is always something to grade.
    await db.execute({ sql: "UPDATE portfolios SET ai_rubric = NULL WHERE url = ?", args: [made.fresh[1]] });
    return drive(ctx, clock);
  };
  const day = 86400000;
  const n1 = await night(T0);
  assert.deepEqual(n1.summary.parked, []);
  await night(T0 + day);
  const n3 = await night(T0 + 2 * day);
  assert.deepEqual(n3.summary.parked.map((p) => [p.job, p.item, p.nights]), [["grade-new", bad, 3]]);
  assert.match(n3.markdown, new RegExp(`Parked \\(failed on 3 nights in a row`));
  // Night 4: the parked site is not asked about.
  const before = Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n);
  const n4 = await night(T0 + 3 * day);
  const after = Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n);
  assert.equal(after - before, 1, "only the good site");
  assert.equal(n4.summary.stages.find((s) => s.key === "grade_new").failed, 0);
});

test("a gap night starts the count over", async () => {
  const { db, made } = await setup({ fresh: 1 });
  await ensureNightSchema(db);
  const f = (night) => recordItemFailure(db, { job: "grade-new", item: made.fresh[0], night, reason: "x", parkAfter: 3, now: T0 });
  assert.deepEqual(await f("2026-11-01"), { nights: 1, parked: false });
  assert.deepEqual(await f("2026-11-02"), { nights: 2, parked: false });
  assert.deepEqual(await f("2026-11-02"), { nights: 2, parked: false }, "the same night counts once");
  assert.deepEqual(await f("2026-11-04"), { nights: 1, parked: false }, "a night without a failure in between");
});

test("a spent daily quota is waiting for tomorrow, not a failure", async () => {
  const { db } = await setup({ fresh: 4, old31: 2 });
  const gemini = mockGemini([ok(), dailyQuota429]);
  const { ctx, clock } = context(db, { gemini });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "stopped");
  assert.match(r.summary.stopped, /daily quota is spent; the rest waits for tomorrow/);
  assert.equal(gemini.calls.length, 2, "it stops at the first 429 for the day");
  assert.ok(gemini.calls.every((c) => c.url.includes(PRIMARY_MODEL)), "never 3.1");
  assert.equal(r.summary.stages.find((s) => s.key === "regrade").result, "not reached");
});

test("a rejected key fails the run", async () => {
  const { db } = await setup({ fresh: 2 });
  const { ctx, clock } = context(db, { gemini: mockGemini([{ status: 403, text: "API key not valid" }]) });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "failed");
  assert.match(r.summary.stopped, /key was rejected/);
});

test("AI ranking comparisons (RANKING_V2 on): within the budget, stored once, then the boards are rebuilt", async () => {
  const { db } = await setup({ fresh: 0, old31: 0 });
  // Six graded sites to compare.
  for (const [k, tier] of ["S", "A", "B", "C", "D", "B"].entries()) {
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, page_text, facts) VALUES (?, ?, 'live', ?, '2026-11-01 00:00:00', ?, 'Hello', ?)`,
      args: [urls[100 + k], `P${k}`, `c${k}`, JSON.stringify({ tier, is_portfolio: true, quality_score: 3.5, rubric_version: 2, model: PRIMARY_MODEL }), facts],
    });
  }
  const gemini = mockGemini((n) => (n % 2 ? ok({ winner: "B", reason: "b" }) : ok({ winner: "A", reason: "a" })));
  const { ctx, clock } = context(db, { gemini, rankingV2: true, rankingBudget: { one_on_one: 3, batched: 0 } });
  const r = await drive(ctx, clock);
  assert.deepEqual(await jobsInOrder(db), ["compare", "compare", "compare", "content"]);
  const rows = (await db.execute("SELECT source, model, method FROM comparisons WHERE rater_type = 'ai' ORDER BY id")).rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => String(x.source)), ["ai-night:2026-11-10:0:0:0", "ai-night:2026-11-10:0:0:1", "ai-night:2026-11-10:0:0:2"]);
  assert.ok(rows.every((x) => x.model === PRIMARY_MODEL && x.method === "one_on_one"));
  assert.ok(Number((await db.execute("SELECT COUNT(*) AS n FROM site_ratings")).rows[0].n) > 0, "boards rebuilt");
  assert.equal(r.summary.stages.find((s) => s.key === "compare").done, 3);
});
