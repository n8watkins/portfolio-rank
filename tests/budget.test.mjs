// The Gemini budget accountant and the end-of-day schedule
// (pipeline/budget.mjs), offline: a throwaway database and fixed clocks, no
// Gemini.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  DEFAULT_PLAN,
  STAGES,
  backgroundAllowance,
  budgetPlan,
  isNightStart,
  nightCrons,
  nightTimeline,
  pacificParts,
  peopleAllowance,
  previousDay,
  quotaDay,
  regradeAllowed,
  reserveFor,
  usageHistory,
  usageToday,
} from "../pipeline/budget.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { createGemini, createLimiter, GeminiRetryBudgetError, PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  return createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
}

async function logRequests(db, rows) {
  await ensureGeminiLog(db);
  for (const r of rows) {
    const log = createRequestLog({ db, job: r.job, runId: "t" });
    for (let i = 0; i < (r.n ?? 1); i++) await log.record({ at: r.at, model: r.model ?? PRIMARY_MODEL, status: r.status ?? 200 });
  }
}

const quota = { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 };

// ---------------------------------------------------------------------------
// The quota day is the Pacific day
// ---------------------------------------------------------------------------
test("the quota day runs midnight to midnight Pacific: 07:00 UTC in summer, 08:00 UTC in winter", () => {
  const summer = quotaDay(new Date("2026-07-15T20:00:00Z"));
  assert.equal(summer.day, "2026-07-15");
  assert.equal(summer.start.toISOString(), "2026-07-15T07:00:00.000Z");
  assert.equal(summer.end.toISOString(), "2026-07-16T07:00:00.000Z");
  const winter = quotaDay(new Date("2026-12-01T05:00:00Z")); // 21:00 on Nov 30 in Los Angeles
  assert.equal(winter.day, "2026-11-30");
  assert.equal(winter.start.toISOString(), "2026-11-30T08:00:00.000Z");
  assert.equal(winter.end.toISOString(), "2026-12-01T08:00:00.000Z");
  // A second before and at midnight Pacific.
  assert.equal(quotaDay(new Date("2026-12-01T07:59:59Z")).day, "2026-11-30");
  assert.equal(quotaDay(new Date("2026-12-01T08:00:00Z")).day, "2026-12-01");
});

test("the two DST days are 23 and 25 hours long", () => {
  const spring = quotaDay(new Date("2026-03-08T20:00:00Z")); // clocks go forward at 2 am
  assert.equal(spring.start.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(spring.end.toISOString(), "2026-03-09T07:00:00.000Z");
  assert.equal((spring.end - spring.start) / 3600000, 23);
  const fall = quotaDay(new Date("2026-11-01T20:00:00Z")); // clocks go back at 2 am
  assert.equal(fall.start.toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(fall.end.toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal((fall.end - fall.start) / 3600000, 25);
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2027-01-01"), "2026-12-31");
});

test("schedule: of the two UTC crons, exactly one lands on 20:30 Pacific each night, all year and across DST", () => {
  assert.deepEqual(nightCrons(), ["30 3 * * *", "30 4 * * *"]);
  // Every day of 2026 and 2027, both crons: exactly one starts, at 20:30 Pacific.
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 86400000) {
    const firings = [3, 4].map((h) => isNightStart(new Date(t + h * 3600000 + 30 * 60000)));
    const starts = firings.filter((f) => f.start);
    assert.equal(starts.length, 1, `one start on ${new Date(t).toISOString().slice(0, 10)}: ${JSON.stringify(firings)}`);
    assert.equal(starts[0].local, "20:30");
  }
  // Summer: 03:30 UTC is 20:30 PDT; winter: 04:30 UTC is 20:30 PST.
  assert.equal(isNightStart(new Date("2026-07-16T03:30:00Z")).start, true);
  assert.equal(isNightStart(new Date("2026-07-16T04:30:00Z")).local, "21:30");
  assert.equal(isNightStart(new Date("2026-12-02T04:30:00Z")).start, true);
  assert.equal(isNightStart(new Date("2026-12-02T03:30:00Z")).local, "19:30");
  // The night is the Pacific date, not the UTC one.
  assert.equal(isNightStart(new Date("2026-12-02T04:30:00Z")).night, "2026-12-01");
  // The evening after each DST change.
  assert.equal(isNightStart(new Date("2026-03-09T03:30:00Z")).start, true, "March 8, the first PDT evening");
  assert.equal(isNightStart(new Date("2026-11-02T04:30:00Z")).start, true, "November 1, the first PST evening");
  assert.equal(isNightStart(new Date("2026-11-02T04:30:00Z")).sunday, true);
});

test("tonight's timeline: the AI stages start 45 minutes in at the latest and stop 30 minutes before the reset", () => {
  const t = nightTimeline(new Date("2026-12-02T04:30:00Z"));
  assert.equal(t.night, "2026-12-01");
  assert.equal(t.checksDeadline, "2026-12-02T05:15:00.000Z");
  assert.equal(t.hardStop, "2026-12-02T07:30:00.000Z"); // 23:30 PST
  assert.equal(t.reset, "2026-12-02T08:00:00.000Z");
  const summer = nightTimeline(new Date("2026-07-16T03:30:00Z"));
  assert.equal(summer.hardStop, "2026-07-16T06:30:00.000Z"); // 23:30 PDT
  assert.equal(pacificParts(new Date(summer.hardStop)).hour, 23);
});

test("dailyTotals counts the Pacific quota day, not the UTC day", async () => {
  const db = tempDb();
  await logRequests(db, [
    { job: "grade-new", at: "2026-11-11T07:59:00.000Z", n: 3 }, // 23:59 Nov 10 Pacific: today
    { job: "grade-new", at: "2026-11-10T07:59:00.000Z", n: 2 }, // 23:59 Nov 9 Pacific: yesterday
  ]);
  const t = await dailyTotals(db, { now: new Date("2026-11-11T07:59:30Z"), quota });
  assert.equal(t.used.get(PRIMARY_MODEL).n, 3);
  assert.match(t.markdown, /Gemini today \(2026-11-10, Pacific quota day\)/);
});

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------
test("a background stage gets min(its cap, quota left minus the reserve)", async () => {
  const db = tempDb();
  const now = new Date("2026-11-11T05:00:00Z"); // 21:00 Pacific
  await logRequests(db, [
    { job: "people-grade", at: "2026-11-10T20:00:00.000Z", n: 100 }, // noon: people
    { job: "rubric", at: "2026-11-10T21:00:00.000Z", n: 50 }, // the old name counts as new grades
    { job: "grade-new", at: "2026-11-11T04:00:00.000Z", n: 30 },
    { job: "compare", at: "2026-11-11T04:30:00.000Z", n: 10, model: BACKUP_MODEL }, // another model's quota
  ]);
  const usage = await usageToday(db, { now });
  assert.equal(usage.day, "2026-11-10");
  assert.equal(usage.byModel[PRIMARY_MODEL], 180);
  assert.equal(usage.byJob["grade-new"][PRIMARY_MODEL], 80);
  assert.equal(usage.peopleLastHour, 0);
  const g = backgroundAllowance("grade_new", usage, { quota });
  // Cap 300 - 80 = 220; quota 500 - 180 - 25 = 295.
  assert.deepEqual([g.allowed, g.remaining, g.reserve, g.used, g.cap], [220, 320, 25, 80, 300]);
  const c = backgroundAllowance("compare", usage, { quota });
  assert.equal(c.allowed, 200, "3.1 requests never count against 3.5's quota");
  // A tight quota: the reserve is never touched.
  const tight = backgroundAllowance("compare", usage, { quota: { [PRIMARY_MODEL]: 200 } });
  assert.deepEqual([tight.allowed, tight.limitedBy], [0, "quota"]);
  const capped = backgroundAllowance("grade_new", usage, { quota, plan: budgetPlan(JSON.stringify({ stages: { grade_new: { cap: 80 } } })) });
  assert.deepEqual([capped.allowed, capped.limitedBy], [0, "cap"]);
});

test("the reserve grows with people's demand in the last hour, and recent people are seen", async () => {
  const db = tempDb();
  const now = new Date("2026-11-11T05:00:00Z");
  await logRequests(db, [
    { job: "people-grade", at: "2026-11-11T04:10:00.000Z", n: 20 }, // 50 minutes ago
    { job: "people-regrade", at: "2026-11-11T04:55:00.000Z", n: 2 }, // 5 minutes ago
    { job: "people-grade", at: "2026-11-11T03:00:00.000Z", n: 40 }, // 2 hours ago: not in the last hour
  ]);
  const usage = await usageToday(db, { now });
  assert.equal(usage.peopleLastHour, 22);
  assert.equal(usage.peopleRecent, 2);
  assert.equal(reserveFor(usage), 44);
  const g = backgroundAllowance("grade_new", usage, { quota: { [PRIMARY_MODEL]: 120 } });
  assert.equal(g.allowed, 120 - 62 - 44);
  assert.equal(reserveFor({ peopleLastHour: 3 }), 25, "never below the base reserve");
});

test("people get everything but the reserve during the day, and the reserve too from the evening run", () => {
  const usage = { byModel: { [PRIMARY_MODEL]: 400 }, byJob: {} };
  assert.equal(peopleAllowance(usage, { quota, now: new Date("2026-11-10T20:00:00Z") }), 75); // noon
  assert.equal(peopleAllowance(usage, { quota, now: new Date("2026-11-11T04:29:00Z") }), 75); // 20:29
  assert.equal(peopleAllowance(usage, { quota, now: new Date("2026-11-11T04:30:00Z") }), 100); // 20:30
  assert.equal(peopleAllowance({ byModel: { [PRIMARY_MODEL]: 520 } }, { quota, now: new Date("2026-11-11T06:00:00Z") }), 0);
});

test("re-grade requests: once a week, or at once when the page changed after the last grade", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  assert.equal(regradeAllowed({ lastGradedAt: null, now }).allowed, true);
  const recent = regradeAllowed({ lastGradedAt: "2026-11-08T12:00:00Z", now });
  assert.deepEqual([recent.allowed, recent.nextAt], [false, "2026-11-15T12:00:00.000Z"]);
  assert.equal(regradeAllowed({ lastGradedAt: "2026-11-08T12:00:00Z", pageChangedAt: "2026-11-09T12:00:00Z", now }).allowed, true);
  assert.equal(regradeAllowed({ lastGradedAt: "2026-11-08T12:00:00Z", pageChangedAt: "2026-11-07T12:00:00Z", now }).allowed, false, "a change before the grade doesn't count");
  assert.equal(regradeAllowed({ lastGradedAt: "2026-11-03T12:00:00Z", now }).allowed, true);
});

test("GEMINI_BUDGET overrides merge over the defaults; a broken value keeps the defaults", () => {
  const p = budgetPlan(JSON.stringify({ reserve: 40, stages: { compare: { cap: 50 } } }));
  assert.equal(p.reserve, 40);
  assert.deepEqual(p.stages.compare, { cap: 50, minutes: 45 });
  assert.deepEqual(p.stages.grade_new, DEFAULT_PLAN.stages.grade_new);
  assert.deepEqual(budgetPlan("{not json"), DEFAULT_PLAN);
  assert.deepEqual(STAGES.map((s) => s.label), ["Grade new sites", "Grade changed sites", "AI ranking comparisons", "Content", "Image library", "Re-grades (3.1 and older rubric)", "Experiments"]);
});

test("usage history: 30 Pacific days, per job and model, newest first, for the admin view", async () => {
  const db = tempDb();
  await logRequests(db, [
    { job: "grade-new", at: "2026-11-11T06:00:00.000Z", n: 4 }, // 22:00 Nov 10 Pacific
    { job: "pairwise", at: "2026-11-10T09:00:00.000Z", n: 2 }, // 01:00 Nov 10 Pacific
    { job: "people-grade", at: "2026-11-09T20:00:00.000Z", n: 3, status: 503 },
    { job: "grade-new", at: "2026-10-01T20:00:00.000Z", n: 9 }, // older than 30 days
  ]);
  const h = await usageHistory(db, { now: new Date("2026-11-11T06:30:00Z"), quota });
  assert.equal(h.days.length, 30);
  assert.equal(h.today.day, "2026-11-10");
  assert.deepEqual(h.today.total, { [PRIMARY_MODEL]: 6 });
  assert.deepEqual(
    h.today.jobs.map((j) => [j.job, j.label, j.requests]),
    [["grade-new", "Grade new sites", 4], ["compare", "AI ranking comparisons", 2]]
  );
  assert.deepEqual(h.days[1].jobs, [{ job: "people-grade", label: "Grade my portfolio (people)", model: PRIMARY_MODEL, requests: 3, ok: 0 }]);
  assert.equal(h.days.at(-1).day, "2026-10-12");
  assert.ok(h.days.every((d) => !d.jobs.some((j) => j.requests === 9)));
});

// ---------------------------------------------------------------------------
// Pacing and the retry budget in the Gemini client
// ---------------------------------------------------------------------------
test("a limiter can continue the pace of an earlier one", async () => {
  let t = 1000;
  const slept = [];
  const sleep = async (ms) => {
    slept.push(ms);
    t += ms;
  };
  const a = createLimiter({ rpm: 6, now: () => t, sleep });
  await a.take();
  assert.equal(a.last, 1000);
  const b = createLimiter({ rpm: 6, lastAt: a.last, now: () => t, sleep });
  await b.take();
  assert.deepEqual(slept, [10000], "the next batch waits out the gap");
});

test("the retry budget caps a client's retries in total", async () => {
  const fetchImpl = async () => new Response("busy", { status: 503 });
  const gemini = createGemini({ apiKey: "k", fetchImpl, sleep: async () => {}, rpm: 60000, retryBudget: 4, log: () => {} });
  await assert.rejects(gemini.generate([{ text: "x" }], {}), /GeminiUnavailableError|unavailable/);
  assert.equal(gemini.counts.retries, 3, "one call: three retries, then it gives up");
  await assert.rejects(gemini.generate([{ text: "x" }], {}), (e) => e instanceof GeminiRetryBudgetError);
  assert.equal(gemini.counts.retries, 4);
});
