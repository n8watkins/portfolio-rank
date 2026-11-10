// Roll-ups and retention of the log tables (pipeline/retention.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { ensureNightSchema } from "../pipeline/night.mjs";
import { ensureRankingSchema, insertComparison, loadInput, inputDigest } from "../lib/ranking/store.mjs";
import { outcomeOf, pruneLogs, retention, rollUpGeminiRequests } from "../pipeline/retention.mjs";
import { usageToday } from "../pipeline/budget.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";

const NOW = new Date("2026-11-10T20:00:00Z"); // noon Pacific

async function db() {
  const d = createClient({ url: ":memory:" });
  await ensureGeminiLog(d);
  return d;
}

test("outcomeOf: ok, cut off, 429, 5xx, network and other 4xx", () => {
  assert.equal(outcomeOf({ status: 200, finish_reason: "STOP" }), "ok");
  assert.equal(outcomeOf({ status: 200, finish_reason: null }), "ok");
  assert.equal(outcomeOf({ status: 200, finish_reason: "MAX_TOKENS" }), "cut_off");
  assert.equal(outcomeOf({ status: 429 }), "429");
  assert.equal(outcomeOf({ status: 503 }), "5xx");
  assert.equal(outcomeOf({ status: 0 }), "network");
  assert.equal(outcomeOf({ status: 400 }), "4xx");
});

test("gemini_requests: whole Pacific days older than 90 roll up into gemini_daily, newer ones stay raw", async () => {
  const d = await db();
  const log = createRequestLog({ db: d, job: "grade-new", runId: "t" });
  const ok = (at, latencyMs, extra = {}) => log.record({ at, model: "m", status: 200, finishReason: "STOP", latencyMs, inputTokens: 100, outputTokens: 10, thoughtsTokens: 5, ...extra });
  // 2026-08-01 Pacific runs 07:00 UTC Aug 1 to 07:00 UTC Aug 2: one day, two UTC dates.
  await ok("2026-08-01T07:00:00.000Z", 100);
  await ok("2026-08-02T06:59:00.000Z", 300, { retry: true });
  await log.record({ at: "2026-08-01T12:00:00.000Z", model: "m", status: 200, finishReason: "MAX_TOKENS", outputTokens: 2048 });
  await log.record({ at: "2026-08-01T12:01:00.000Z", model: "m", status: 429, reason: "HTTP 429 daily quota", detail: "{...}" });
  await ok("2026-08-03T12:00:00.000Z", 200); // another old day
  await ok("2026-11-10T12:00:00.000Z", 50); // recent: stays
  const r = await rollUpGeminiRequests(d, { now: NOW });
  assert.deepEqual(r, { days: 2, rows: 5 });
  const daily = (await d.execute("SELECT day, job, outcome, requests, retries, input_tokens, output_tokens, thoughts_tokens, latency_p50, latency_p95 FROM gemini_daily ORDER BY day, outcome")).rows.map((x) => ({ ...x }));
  assert.deepEqual(daily, [
    { day: "2026-08-01", job: "grade-new", outcome: "429", requests: 1, retries: 0, input_tokens: 0, output_tokens: 0, thoughts_tokens: 0, latency_p50: null, latency_p95: null },
    { day: "2026-08-01", job: "grade-new", outcome: "cut_off", requests: 1, retries: 0, input_tokens: 0, output_tokens: 2048, thoughts_tokens: 0, latency_p50: null, latency_p95: null },
    { day: "2026-08-01", job: "grade-new", outcome: "ok", requests: 2, retries: 1, input_tokens: 200, output_tokens: 20, thoughts_tokens: 10, latency_p50: 300, latency_p95: 300 },
    { day: "2026-08-03", job: "grade-new", outcome: "ok", requests: 1, retries: 0, input_tokens: 100, output_tokens: 10, thoughts_tokens: 5, latency_p50: 200, latency_p95: 200 },
  ]);
  assert.deepEqual((await d.execute("SELECT at FROM gemini_requests")).rows.map((x) => x.at), ["2026-11-10T12:00:00.000Z"]);
  // Today's budget still sees today's raw rows.
  assert.equal((await usageToday(d, { now: NOW })).byModel.m, 1);
  // Running it again changes nothing.
  assert.deepEqual(await rollUpGeminiRequests(d, { now: NOW }), { days: 0, rows: 0 });
  assert.equal(Number((await d.execute("SELECT SUM(requests) AS n FROM gemini_daily")).rows[0].n), 5);
});

test("the 90-day line falls on a Pacific midnight: a day is never split between raw and rolled up", async () => {
  const d = await db();
  const log = createRequestLog({ db: d, job: "x", runId: "t" });
  // NOW minus 90 days is 2026-08-12 13:00 UTC, inside the 2026-08-12 Pacific day: that whole day stays raw.
  await log.record({ at: "2026-08-12T07:00:00.000Z", model: "m", status: 200 });
  await log.record({ at: "2026-08-12T06:59:59.000Z", model: "m", status: 200 }); // 23:59 on Aug 11 Pacific
  await rollUpGeminiRequests(d, { now: NOW });
  assert.deepEqual((await d.execute("SELECT at FROM gemini_requests")).rows.map((x) => x.at), ["2026-08-12T07:00:00.000Z"]);
  assert.deepEqual((await d.execute("SELECT day FROM gemini_daily")).rows.map((x) => x.day), ["2026-08-11"]);
});

test("night runs older than 180 days go; comparisons keep everything the recompute reads, only old reasons are cleared", async () => {
  const d = await db();
  await ensureNightSchema(d);
  await ensureRankingSchema(d);
  await ensureRosterSchema(d);
  await d.batch([
    "INSERT INTO night_runs (night, started_at, status) VALUES ('2026-05-01', '2026-05-02T03:30:00Z', 'done')",
    "INSERT INTO night_runs (night, started_at, status) VALUES ('2026-11-09', '2026-11-10T04:30:00Z', 'done')",
  ]);
  const c = (created_at, i) =>
    insertComparison(d, { created_at, rater_type: "ai", model: "m", prompt_version: "p1", method: "one_on_one", shown: ["a", "b"], ranking: [["a"], ["b"]], reason: "A is cleaner", source: `s${i}` });
  await c("2026-08-01T00:00:00.000Z", 1); // 101 days old
  await c("2026-10-30T00:00:00.000Z", 2); // recent
  const before = inputDigest(await loadInput(d));
  const out = await pruneLogs(d, { now: NOW });
  assert.deepEqual(out, { nightRuns: 1, reasons: 1, alerts: 0, reportLinks: 0, badgeChecks: 0 });
  assert.deepEqual((await d.execute("SELECT night FROM night_runs")).rows.map((x) => x.night), ["2026-11-09"]);
  const rows = (await d.execute("SELECT source, shown, ranking, reason FROM comparisons ORDER BY source")).rows.map((x) => [x.source, x.shown, x.ranking, x.reason]);
  assert.deepEqual(rows, [
    ["s1", '["a","b"]', '[["a"],["b"]]', null],
    ["s2", '["a","b"]', '[["a"],["b"]]', "A is cleaner"],
  ]);
  // The public recompute's input is unchanged.
  assert.equal(inputDigest(await loadInput(d)), before);
  // The whole pass runs on a database without some of the tables.
  assert.ok(await retention(createClient({ url: ":memory:" }), { now: NOW }));
});
