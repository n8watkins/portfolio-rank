// Cut-off answers and error bodies (ASSUMPTIONS.md tests G3 and G5): every
// Gemini response's finishReason is logged, an answer that did not finish
// with STOP is a failed answer that is never stored, and the first 300
// characters of an error body (which 429 limit was hit) are kept, without
// anything key-like.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createGemini, errorDetail, finishReasonOf, GeminiIncompleteError, GeminiQuotaError, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog, runSummary } from "../pipeline/gemini-log.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { MAX_OUTPUT_TOKENS as RUBRIC_CAP } from "../pipeline/rubric.mjs";
import { MAX_OUTPUT_TOKENS as COMPARE_CAP } from "../pipeline/compare-prompts.mjs";
import feed from "../data/feed.json" with { type: "json" };

const KEY = "AIzaSyTESTKEY0123456789abcdefghijklmn";
const answer = (json, extra = {}) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, ...extra }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 600, thoughtsTokenCount: 400 } }), {
    status: 200,
  });

async function client(responses) {
  const db = createClient({ url: ":memory:" });
  await ensureGeminiLog(db);
  const log = createRequestLog({ db, job: "grade-new", runId: "t" });
  let n = 0;
  const gemini = createGemini({
    apiKey: KEY,
    rpm: 1e6,
    sleep: async () => {},
    log: () => {},
    onRequest: (r) => log.record(r),
    fetchImpl: async () => responses[Math.min(n++, responses.length - 1)](),
  });
  return { db, log, gemini, calls: () => n };
}

test("finishReasonOf reads the candidate's reason, or the prompt's block reason", () => {
  assert.equal(finishReasonOf({ candidates: [{ finishReason: "STOP" }] }), "STOP");
  assert.equal(finishReasonOf({ candidates: [{ finishReason: "MAX_TOKENS" }] }), "MAX_TOKENS");
  assert.equal(finishReasonOf({ promptFeedback: { blockReason: "SAFETY" } }), "BLOCKED:SAFETY");
  assert.equal(finishReasonOf({ candidates: [{}] }), null);
});

test("a STOP answer is returned and its finishReason logged", async () => {
  const { db, gemini } = await client([() => answer({ ok: 1 }, { finishReason: "STOP" })]);
  const out = await gemini.generate([{ text: "x" }], {});
  assert.deepEqual(out.result, { ok: 1 });
  const row = (await db.execute("SELECT status, reason, finish_reason, detail FROM gemini_requests")).rows[0];
  assert.deepEqual([row.status, row.reason, row.finish_reason, row.detail], [200, "ok", "STOP", null]);
});

for (const reason of ["MAX_TOKENS", "SAFETY", "RECITATION", "OTHER"]) {
  test(`a ${reason} answer is a failed answer, logged as cut off and not retried`, async () => {
    const { db, log, gemini, calls } = await client([() => answer({ tier: "B" }, { finishReason: reason })]);
    await assert.rejects(gemini.generate([{ text: "x" }], {}), (e) => e instanceof GeminiIncompleteError && e.finishReason === reason);
    assert.equal(calls(), 1, "not retried: the same request would be cut again");
    const row = (await db.execute("SELECT status, reason, finish_reason, output_tokens, thoughts_tokens FROM gemini_requests")).rows[0];
    assert.deepEqual([row.status, row.reason, row.finish_reason, row.output_tokens, row.thoughts_tokens], [200, `incomplete: ${reason}`, reason, 600, 400]);
    assert.equal(gemini.counts.incomplete, 1);
    // Summaries count it as cut off, not answered.
    assert.match(runSummary(log.rows), new RegExp(`\\| ${PRIMARY_MODEL} \\| 1 \\| 0 \\| 1 \\|`));
    const totals = await dailyTotals(db, { now: new Date(String((await db.execute("SELECT at FROM gemini_requests")).rows[0].at)) });
    assert.equal(totals.used.get(PRIMARY_MODEL).ok, 0);
  });
}

test("a blocked prompt (no candidate) is a failed answer too", async () => {
  const { db, gemini } = await client([() => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })]);
  await assert.rejects(gemini.generate([{ text: "x" }], {}), GeminiIncompleteError);
  assert.equal((await db.execute("SELECT finish_reason FROM gemini_requests")).rows[0].finish_reason, "BLOCKED:SAFETY");
});

test("a 429 keeps the first 300 characters of Google's body, without the key", async () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500 (key ${KEY}, https://x.test/?key=${KEY})`,
      status: "RESOURCE_EXHAUSTED",
      details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
    },
  }, null, 2);
  const { db, gemini } = await client([() => new Response(body, { status: 429 })]);
  await assert.rejects(gemini.generate([{ text: "x" }], {}), GeminiQuotaError);
  const row = (await db.execute("SELECT reason, detail FROM gemini_requests")).rows[0];
  assert.equal(row.reason, "HTTP 429 daily quota");
  assert.ok(String(row.detail).length <= 300);
  assert.match(String(row.detail), /^\{ "error": \{ "code": 429, "message": "Quota exceeded for metric/);
  assert.doesNotMatch(String(row.detail), new RegExp(KEY));
  assert.doesNotMatch(String(row.detail), /\n/);
});

test("errorDetail removes the client's key and anything key-like, and caps the length", () => {
  assert.equal(errorDetail("bad key secret-123 here", { apiKey: "secret-123" }), "bad key [key] here");
  assert.equal(errorDetail("AQ.Ab8RN6abcdefghijklmnop failed"), "[key] failed");
  assert.equal(errorDetail("see https://a.test/x?key=abc&y=1"), "see https://a.test/x?key=[key]&y=1");
  assert.equal(errorDetail("x".repeat(500)).length, 300);
});

test("the answer caps leave room for thinking tokens (maxOutputTokens counts them)", () => {
  assert.ok(RUBRIC_CAP >= 2048, `rubric cap ${RUBRIC_CAP}`);
  assert.ok(COMPARE_CAP >= 1024, `comparison cap ${COMPARE_CAP}`);
});

test("judge rubric: a MAX_TOKENS answer is not stored as a grade", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finish-"));
  const dbFile = path.join(dir, "db.sqlite");
  const db = createClient({ url: `file:${dbFile}` });
  await ensureRosterSchema(db);
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL, pair_key TEXT,
       rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER)`,
    `CREATE TABLE ratings (url TEXT PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1200, votes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ]);
  const url = feed[0].url;
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at) VALUES (?, 'S', 'live', 'k1', datetime('now'))", args: [url] });
  const truncated = { is_portfolio: true, tier: "B" };
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", "rubric", "--rpm", "60000", "--no-browser"], {
      env: {
        ...process.env,
        TURSO_DATABASE_URL: `file:${dbFile}`,
        TURSO_AUTH_TOKEN: "",
        GEMINI_API_KEY: "test-key-not-real",
        SHOTS_BASE_URL: "https://shots.test",
        GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
        MOCK_GEMINI: JSON.stringify([{ json: truncated, finishReason: "MAX_TOKENS" }]),
      },
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
  assert.notEqual(code, null);
  assert.equal((await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0].ai_rubric, null);
  const logged = (await db.execute("SELECT finish_reason FROM gemini_requests")).rows.map((r) => r.finish_reason);
  assert.deepEqual(logged, ["MAX_TOKENS"]);
});
