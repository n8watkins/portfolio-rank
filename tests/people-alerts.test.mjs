// People's grade requests (pipeline/people.mjs) and the owner alerts that
// repeat until resolved (pipeline/alerts.mjs), offline: a throwaway
// database, a simulated clock and a mocked Gemini.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { budgetPlan } from "../pipeline/budget.mjs";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { drainPeopleQueue, readRequest, requestGrade } from "../pipeline/people.mjs";
import { activeAlerts, nightConditions, reconcileAlerts, tractionConditions } from "../pipeline/alerts.mjs";

const answer = { is_portfolio: true, tier: "A", ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 4, note: "good" }])) };
const T0 = Date.parse("2026-11-10T20:00:00Z"); // noon Pacific

function tempDb() {
  return createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "people-")), "db.sqlite")}` });
}

function context(db, { quota = 500, responses, email = null } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const sent = [];
  return {
    clock,
    calls,
    sent,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(),
      quota: { [PRIMARY_MODEL]: quota, [BACKUP_MODEL]: 500 },
      rpm: 60,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: () => {},
      fetchImpl: async (url) => {
        calls.push(String(url));
        const r = responses(calls.length - 1);
        if (r.status !== 200) return new Response(r.text ?? "", { status: r.status });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(r.json) }] } }] }), { status: 200 });
      },
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      email: email ?? { send: async (m) => sent.push(m) },
      runId: "test",
    },
  };
}

const input = { url: "https://someone.dev", name: "Someone", email: "someone@example.com", shot_key: "k1", page_text: "Hi, I build things.", facts: { source: "http", github: true } };
const dailyQuota429 = { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}' };

test("a person's grade runs at once on 3.5, is logged as people-grade, and the person is emailed", async () => {
  const db = tempDb();
  const { ctx, calls, sent } = context(db, { responses: () => ({ status: 200, json: answer }) });
  const r = await requestGrade(ctx, input);
  assert.equal(r.status, "done");
  assert.equal(r.result.tier, "A");
  assert.equal(r.result.model, PRIMARY_MODEL);
  assert.equal(calls.length, 1);
  assert.deepEqual((await db.execute("SELECT job FROM gemini_requests")).rows.map((x) => x.job), ["people-grade"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "someone@example.com");
  assert.ok(r.notified_at);
});

test("3.5 busy through its retries: the request is queued, never sent to 3.1, and finished later", async () => {
  const db = tempDb();
  let busy = true;
  const { ctx, calls, sent } = context(db, { responses: () => (busy ? { status: 503 } : { status: 200, json: answer }) });
  const r = await requestGrade(ctx, input);
  assert.equal(r.status, "queued");
  assert.match(r.reason, /waiting for Gemini 3\.5/);
  assert.equal(calls.length, 4, "the usual retries: 10, 30 and 60 seconds");
  assert.ok(calls.every((u) => u.includes(PRIMARY_MODEL)), "never 3.1");
  assert.equal(sent.length, 0);
  busy = false;
  assert.deepEqual(await drainPeopleQueue(ctx), { done: 1, queued: 0, failed: 0 });
  assert.equal((await readRequest(db, Number(r.id))).status, "done");
  assert.equal(sent.length, 1, "emailed when done");
});

test("a spent quota queues people's requests until there is quota again; the evening reserve opens at 20:30", async () => {
  const db = tempDb();
  await ensureGeminiLog(db);
  // 480 of 500 used by noon: people's share stops at the 25 reserve.
  const log = createRequestLog({ db, job: "grade-new" });
  for (let i = 0; i < 480; i++) await log.record({ at: new Date(T0 - 3600000).toISOString(), model: PRIMARY_MODEL, status: 200 });
  const { ctx, calls, clock } = context(db, { responses: () => ({ status: 200, json: answer }) });
  const r = await requestGrade(ctx, input);
  assert.equal(r.status, "queued");
  assert.match(r.reason, /quota is used/);
  assert.equal(calls.length, 0, "no request is sent past the people's share");
  clock.t = Date.parse("2026-11-11T04:30:00Z"); // 20:30 Pacific: the reserve is for people now
  assert.equal((await drainPeopleQueue(ctx)).done, 1);
  // A real 429 for the day also just queues it.
  const { ctx: ctx2 } = context(tempDb(), { responses: () => dailyQuota429 });
  assert.equal((await requestGrade(ctx2, input)).status, "queued");
});

test("a request that fails on its own three times is marked failed, not retried forever", async () => {
  const db = tempDb();
  const { ctx } = context(db, { responses: () => ({ status: 200, json: { tier: "Z" } }) });
  const r = await requestGrade(ctx, input);
  assert.equal(r.status, "queued");
  await drainPeopleQueue(ctx);
  await drainPeopleQueue(ctx);
  const after = await readRequest(db, Number(r.id));
  assert.equal(after.status, "failed");
  assert.equal(Number(after.attempts), 3);
  assert.deepEqual(await drainPeopleQueue(ctx), { done: 0, queued: 0, failed: 0 });
});

// ---------------------------------------------------------------------------
// Owner alerts
// ---------------------------------------------------------------------------
const summary = (over = {}) => ({
  night: "2026-11-10",
  estimate: { quotaLeft: 300 },
  stages: [{ key: "grade_new", label: "Grade new sites", result: "done: nothing left" }],
  parked: [],
  ...over,
});

test("alerts: each condition emails once a day, repeats every day while it holds, and clears", async () => {
  const db = tempDb();
  const sent = [];
  const email = { send: async (m) => sent.push(m) };
  const plan = budgetPlan();
  const bad = summary({
    estimate: { quotaLeft: 10 },
    stages: [{ key: "compare", label: "AI ranking comparisons", result: "circuit breaker: 5 failures in a row (last: x)" }],
    parked: [{ job: "grade-new", item: "https://x.dev", reason: "bad answer" }],
  });
  const conditions = nightConditions(bad, plan);
  assert.deepEqual(conditions.map((c) => c.key), ["quota-before-night", "circuit-breaker:compare", "parked"]);
  const day1 = new Date("2026-11-11T05:00:00Z");
  const r1 = await reconcileAlerts(db, { conditions, now: day1, email, to: "owner@example.com" });
  assert.equal(r1.sent.length, 3);
  // Same day again: nothing more.
  const again = await reconcileAlerts(db, { conditions, now: new Date("2026-11-11T07:00:00Z"), email, to: "owner@example.com" });
  assert.equal(again.sent.length, 0, "never more than one email per condition per day");
  // Next day, the breaker cleared, the rest still holds: those repeat.
  const day2 = nightConditions(summary({ estimate: { quotaLeft: 10 }, parked: bad.parked }), plan);
  const r2 = await reconcileAlerts(db, { conditions: day2, now: new Date("2026-11-12T05:00:00Z"), email, to: "owner@example.com" });
  assert.deepEqual(r2.sent.sort(), ["parked", "quota-before-night"]);
  assert.deepEqual(r2.cleared, ["circuit-breaker:compare"]);
  assert.equal(sent.length, 5);
  assert.match(sent[3].text, /repeats once a day until it clears/);
  assert.deepEqual((await activeAlerts(db)).map((a) => [a.key, a.sends]).sort(), [["parked", 2], ["quota-before-night", 2]]);
  // All clear.
  const r3 = await reconcileAlerts(db, { conditions: [], now: new Date("2026-11-13T05:00:00Z"), email, to: "owner@example.com" });
  assert.equal(r3.cleared.length, 2);
  assert.deepEqual(await activeAlerts(db), []);
});

test("alerts: with no email provider they are recorded and retried each day, never marked sent", async () => {
  const db = tempDb();
  const conditions = nightConditions(summary({ estimate: { quotaLeft: 0 } }), budgetPlan());
  const r = await reconcileAlerts(db, { conditions, now: new Date("2026-11-11T05:00:00Z"), email: null, to: null });
  assert.deepEqual(r.unsent, ["quota-before-night"]);
  const [a] = await activeAlerts(db);
  assert.equal(a.sends, 0);
  assert.equal(a.last_sent_day, null);
});

test("alerts: traction levels for people's grade requests and human votes", async () => {
  const db = tempDb();
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY, rater_type TEXT, created_at TEXT)`);
  for (let i = 0; i < 4; i++) await db.execute({ sql: "INSERT INTO votes (rater_type, created_at) VALUES ('human', ?)", args: ["2026-11-10 20:00:00"] });
  await db.execute({ sql: "INSERT INTO votes (rater_type, created_at) VALUES ('ai', ?)", args: ["2026-11-10 20:00:00"] });
  const { ctx } = context(db, { responses: () => ({ status: 200, json: answer }) });
  await requestGrade(ctx, input);
  await requestGrade(ctx, input);
  const now = new Date("2026-11-11T05:00:00Z"); // 21:00 on Nov 10 Pacific
  const c = await tractionConditions(db, { now, levels: { peopleGrades: 2, humanVotes: 4 } });
  assert.deepEqual(c.map((x) => x.key), ["traction:people-grades", "traction:human-votes"]);
  assert.match(c[0].title, /PortfolioRank is doing well/);
  assert.deepEqual(await tractionConditions(db, { now, levels: { peopleGrades: 3, humanVotes: 5 } }), []);
});
