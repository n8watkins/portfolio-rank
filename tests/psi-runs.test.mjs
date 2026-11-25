// Two Lighthouse runs a device, averaged (lib/psi-runs.mjs), the method
// sentence a profile may show, and the pacing arithmetic (lib/psi-pacing.mjs).
// No network: runs are stand-in results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNS_PER_DEVICE, averageRuns, formatMetric, measureDevice, measureSite, methodSentence, methodSentences, needsMoreRuns, runCount } from "../lib/psi-runs.mjs";
import { DEFAULT_RUN_GAP_MS, PSI_DAILY_CAP, PSI_PER_MINUTE_CAP, PREWARM_CONCURRENCY, RUNS_PER_SITE, backfillDays, pacing, steadyRunsPerDay } from "../lib/psi-pacing.mjs";
import { PREWARM_LIMIT, PREWARM_PLAN } from "../scripts/lib/prewarm.mjs";
import { LIMITS, PROJECTIONS } from "../lib/admin/limits.mjs";

const run = (perf, extra = {}) => ({
  ok: true,
  strategy: "mobile",
  scores: { performance: perf, accessibility: 90, "best-practices": 80, seo: 100 },
  metrics: [
    { id: "largest-contentful-paint", label: "Largest Contentful Paint", value: "x", score: 0.5, numeric: 2000 + perf * 10 },
    { id: "total-blocking-time", label: "Total Blocking Time", value: "x", score: 0.8, numeric: 100 },
    { id: "cumulative-layout-shift", label: "Cumulative Layout Shift", value: "x", score: 1, numeric: 0.01 },
  ],
  fixes: [{ id: "f", title: "Fix", tip: "tip", category: "performance" }],
  weight: { bytes: 1000, requests: 10 },
  finalUrl: "https://a.example/",
  runs: 1,
  runsAttempted: 1,
  runScores: [perf],
  ...extra,
});
const NOW = new Date("2026-11-25T10:00:00Z");

test("two good runs: scores and metrics are averaged, and the run details say so", () => {
  const r = averageRuns([run(60, { fetchedAt: "a" }), run(80, { fetchedAt: "b" })], { strategy: "mobile", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.runs, 2);
  assert.equal(r.runsAttempted, 2);
  assert.deepEqual(r.runScores, [60, 80]);
  assert.equal(r.ranAt, "2026-11-25T10:00:00.000Z");
  assert.equal(r.scores.performance, 70);
  assert.equal(r.scores.accessibility, 90);
  const lcp = r.metrics.find((m) => m.id === "largest-contentful-paint");
  assert.equal(lcp.numeric, 2700);
  assert.equal(lcp.value, "2.7 s");
  assert.equal(r.metrics.find((m) => m.id === "total-blocking-time").value, "100 ms");
  assert.equal(r.metrics.find((m) => m.id === "cumulative-layout-shift").value, "0.01");
  assert.equal(lcp.score, 0.5);
  assert.deepEqual(r.weight, { bytes: 1000, requests: 10 });
  assert.equal(r.finalUrl, "https://a.example/");
  assert.equal(r.fixes.length, 1);
});

test("the average rounds to whole points, like one run's score", () => {
  const r = averageRuns([run(61), run(70)], { strategy: "mobile" });
  assert.equal(r.scores.performance, 66); // 65.5 rounds up
});

test("a category one run lacks is averaged from the other; none at all stays null", () => {
  const a = run(60);
  const b = run(80);
  a.scores.seo = null;
  b.scores.seo = null;
  b.scores.accessibility = null;
  const r = averageRuns([a, b], { strategy: "mobile" });
  assert.equal(r.scores.seo, null);
  assert.equal(r.scores.accessibility, 90);
});

test("one run failing: the other is kept, marked one run, with the attempt counted", () => {
  const r = averageRuns([run(60), { ok: false, error: "timeout", strategy: "mobile" }], { strategy: "mobile", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.runs, 1);
  assert.equal(r.runsAttempted, 2);
  assert.deepEqual(r.runScores, [60, null]);
  assert.equal(r.scores.performance, 60);
  assert.equal(methodSentence({ ...r, measuredAt: "2026-11-25T10:00:00Z" }), "One Lighthouse run on 25 Nov 2026");
});

test("a repeated run (PageSpeed answered from its cache) counts once, never as an average", () => {
  const r = averageRuns([run(60, { fetchedAt: "same" }), run(60, { fetchedAt: "same" })], { strategy: "mobile" });
  assert.equal(r.runs, 1);
  assert.equal(r.runsAttempted, 2);
  assert.deepEqual(r.runScores, [60, null]);
});

test("every run failing: the first failure, with no runs", () => {
  const r = averageRuns([{ ok: false, error: "unreachable", strategy: "desktop" }, { ok: false, error: "timeout" }], { strategy: "desktop", now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unreachable");
  assert.equal(r.runs, 0);
  assert.equal(r.runsAttempted, 2);
  assert.equal(methodSentence(r), null);
});

test("runs stored before raw values were kept: the first run's text stands", () => {
  const old = (perf, value) => run(perf, { metrics: [{ id: "largest-contentful-paint", label: "LCP", value, score: 0.5 }] });
  const r = averageRuns([old(60, "2.0 s"), old(80, "3.0 s")], { strategy: "mobile" });
  assert.equal(r.metrics[0].value, "2.0 s");
  assert.equal(r.metrics[0].numeric, undefined);
});

test("metric text follows Lighthouse's style", () => {
  assert.equal(formatMetric("largest-contentful-paint", 2740), "2.7 s");
  assert.equal(formatMetric("speed-index", 12000), "12.0 s");
  assert.equal(formatMetric("total-blocking-time", 214), "210 ms");
  assert.equal(formatMetric("cumulative-layout-shift", 0.12345), "0.123");
  assert.equal(formatMetric("cumulative-layout-shift", 0), "0");
});

test("an old stored row reads as one phone run", () => {
  const old = { ok: true, scores: { performance: 50 }, metrics: [], measuredAt: "2026-10-01T08:00:00.000Z" };
  assert.equal(runCount(old), 1);
  assert.equal(methodSentence(old), "One Lighthouse run on 1 Oct 2026");
  assert.equal(needsMoreRuns(old), true);
  assert.equal(runCount({ ok: false, error: "quota" }), 0);
  assert.equal(runCount(null), 0);
});

test("method sentence: two runs say averaged, one run never does", () => {
  assert.equal(methodSentence({ ok: true, runs: 2, runsAttempted: 2, ranAt: "2026-11-25T23:59:00Z" }), "Two Lighthouse runs on 25 Nov 2026, averaged");
  assert.equal(methodSentence({ ok: true, runs: 1, runsAttempted: 2, ranAt: "2026-11-25T01:00:00Z" }), "One Lighthouse run on 25 Nov 2026");
  assert.doesNotMatch(methodSentence({ ok: true, runs: 1, ranAt: "2026-11-25T01:00:00Z" }), /averag/);
  // The date is when it ran; the cache's date stands in when the result has none.
  assert.equal(methodSentence({ ok: true, runs: 2, measuredAt: "2026-01-05T00:00:00Z" }), "Two Lighthouse runs on 5 Jan 2026, averaged");
  assert.equal(methodSentence({ ok: true, runs: 2, ranAt: "2026-02-03T00:00:00Z", measuredAt: "2026-02-04T00:00:00Z" }), "Two Lighthouse runs on 3 Feb 2026, averaged");
  assert.equal(methodSentence({ ok: true, runs: 2 }), "Two Lighthouse runs, averaged");
  assert.equal(methodSentence({ ok: true, runs: 1, ranAt: "garbage" }), "One Lighthouse run");
  assert.equal(methodSentence(null), null);
  assert.equal(methodSentence({ ok: false, error: "x" }), null);
});

test("method sentence per device", () => {
  const s = methodSentences({
    mobile: { ok: true, runs: 2, ranAt: "2026-11-25T01:00:00Z" },
    desktop: { ok: true, runs: 1, ranAt: "2026-11-25T01:00:00Z" },
  });
  assert.deepEqual(s, { mobile: "Two Lighthouse runs on 25 Nov 2026, averaged", desktop: "One Lighthouse run on 25 Nov 2026" });
  assert.deepEqual(methodSentences({ mobile: { ok: true } }), { mobile: "One Lighthouse run", desktop: null });
});

test("a row needs more runs until two were attempted", () => {
  assert.equal(needsMoreRuns({ ok: true }), true);
  assert.equal(needsMoreRuns({ ok: true, runsAttempted: 1 }), true);
  assert.equal(needsMoreRuns({ ok: true, runs: 1, runsAttempted: 2 }), false);
  assert.equal(needsMoreRuns({ ok: true, runs: 2, runsAttempted: 2 }), false);
  assert.equal(needsMoreRuns({ ok: false, error: "quota" }), false);
});

test("a site's measure is two runs a device, a pause between a device's runs, the devices side by side", async () => {
  const calls = [];
  const sleeps = [];
  let t = 0;
  const fake = async (target, strategy) => {
    calls.push(`${strategy}:${target}`);
    return run(strategy === "mobile" ? 60 + t++ : 90, { strategy, fetchedAt: `${strategy}${t}` });
  };
  const { mobile, desktop } = await measureSite("https://a.example/", { run: fake, gapMs: 30_000, sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((c) => c.startsWith("mobile")).length, 2);
  assert.equal(calls.filter((c) => c.startsWith("desktop")).length, 2);
  assert.deepEqual(sleeps, [30_000, 30_000], "one pause per device, between its two runs");
  assert.equal(mobile.runs, 2);
  assert.equal(desktop.runs, 2);
  assert.equal(RUNS_PER_DEVICE, 2);
});

test("a refused quota stops a device after one call", async () => {
  let n = 0;
  const r = await measureDevice("https://a.example/", "mobile", { run: async () => (n++, { ok: false, error: "quota", strategy: "mobile" }), gapMs: 0 });
  assert.equal(n, 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, "quota");
  assert.equal(r.runsAttempted, 1);
});

test("pacing: four runs a site against the daily and the per-minute limits", () => {
  assert.equal(RUNS_PER_SITE, 4);
  const p = pacing({ sites: 400, concurrency: 3, runGapMs: 30_000, secondsPerRun: 25 });
  assert.equal(p.runsPerDay, 1600);
  assert.equal(p.shareOfDailyCap, 0.064);
  assert.equal(p.secondsPerSite, 80);
  assert.equal(Math.round(p.hours * 100) / 100, 2.96);
  assert.equal(p.peakCallsPerMinute, 15);
  assert.equal(p.withinPerMinute, true);
  assert.equal(p.withinDay, true);
  // One site at a time would not fit the job's 330 minutes (5.5 hours).
  assert.ok(pacing({ sites: 400, concurrency: 1 }).hours > 5.5);
  assert.ok(PREWARM_PLAN.hours * 60 < 330);
  // The most sites the day's cap allows is 6,250.
  assert.equal(pacing({ sites: 6250 }).withinDay, true);
  assert.equal(pacing({ sites: 6251 }).withinDay, false);
  assert.equal(pacing({ sites: 10, concurrency: 200 }).withinPerMinute, false);
});

test("the prewarm's own schedule is inside Google's limits", () => {
  assert.equal(PREWARM_PLAN.runsPerDay, PREWARM_LIMIT * 4);
  assert.ok(PREWARM_PLAN.runsPerDay < PSI_DAILY_CAP);
  assert.ok(PREWARM_PLAN.peakCallsPerMinute < PSI_PER_MINUTE_CAP);
  assert.equal(PREWARM_PLAN.peakCallsPerMinute, 15);
  assert.equal(DEFAULT_RUN_GAP_MS, 30_000);
  assert.equal(PREWARM_CONCURRENCY, 3);
});

test("steady state and backfill arithmetic", () => {
  assert.equal(steadyRunsPerDay(2159), 96); // 24 sites a day, four runs each
  assert.equal(steadyRunsPerDay(5000), 224);
  assert.equal(steadyRunsPerDay(20000), 892);
  assert.equal(steadyRunsPerDay(50000), 2224);
  assert.equal(backfillDays(2159, 400), 6);
  assert.equal(backfillDays(400, 400), 1);
});

test("the admin limits page states the new use and projects four runs a measure", () => {
  const psi = LIMITS.find((l) => l.key === "psi");
  assert.equal(psi.cap, PSI_DAILY_CAP);
  assert.match(psi.label, /four a site/);
  assert.match(psi.over, /240 assumed/);
  for (const size of [5000, 20000, 50000]) assert.ok(PROJECTIONS.psi[size] >= steadyRunsPerDay(size), `${size}`);
  assert.ok(PROJECTIONS.psi[50000] < PSI_DAILY_CAP);
});
