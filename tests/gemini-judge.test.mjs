// The AI judge's Gemini client (pipeline/gemini.mjs) and AI vote identity
// (pipeline/ai-votes.mjs). No server or network: fetch is a stand-in that
// records each request and answers from a script.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  BACKUP_MODEL,
  createGemini,
  createLimiter,
  fallbackEnabled,
  FLASH_LITE_CHAIN,
  GeminiAuthError,
  GeminiQuotaError,
  GeminiUnavailableError,
  isDailyQuota,
  judgeModels,
  PRIMARY_MODEL,
  retryDelayFrom,
} from "../pipeline/gemini.mjs";
import { FLASH_LITE_RATER_ID, prepareAiVotes, raterIdFor } from "../pipeline/ai-votes.mjs";

const KEY = "AQ.test-key-not-real";
const answer = (obj, usage = { promptTokenCount: 1200, candidatesTokenCount: 80 }) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
// Google's 429 bodies: a per-day quota vs a per-minute limit.
const dailyQuota = () =>
  status(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }));
const perMinute = (delay = "7s") =>
  status(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } }));
const status = (code, body = "{}") => new Response(body, { status: code });

// responses: model -> array of (Response | Error) consumed in order.
function fakeGemini(responses, opts = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const model = url.match(/models\/([^:]+):generateContent$/)?.[1];
    seen.push({ url, model, headers: init.headers });
    const next = responses[model]?.shift();
    if (!next) throw new Error(`no scripted response for ${model}`);
    if (next instanceof Error) throw next;
    return next;
  };
  const sleeps = [];
  const records = [];
  const client = createGemini({
    apiKey: KEY,
    rpm: 60000,
    retryDelaysMs: [10000, 30000, 60000],
    jitter: () => 1,
    sleep: async (ms) => void sleeps.push(ms),
    log: () => {},
    onRequest: (r) => void records.push(r),
    fetchImpl,
    ...opts,
  });
  return { client, seen, sleeps, records };
}

test("sends the key in the x-goog-api-key header, never in the URL", async () => {
  const { client, seen } = fakeGemini({ [PRIMARY_MODEL]: [answer({ winner: "A" })] });
  const { result, model } = await client.generate([{ text: "hi" }], {});
  assert.deepEqual(result, { winner: "A" });
  assert.equal(model, PRIMARY_MODEL);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["x-goog-api-key"], KEY);
  assert.ok(!seen[0].url.includes(KEY), "key must not appear in the URL");
  assert.ok(!seen[0].url.includes("key="), "no key query parameter");
});

test("3.5 Flash-Lite alone by default; the 3.1 chain only with GEMINI_FALLBACK=on", () => {
  assert.deepEqual(FLASH_LITE_CHAIN, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(judgeModels({}), [PRIMARY_MODEL]);
  assert.deepEqual(judgeModels({ GEMINI_FALLBACK: "off" }), [PRIMARY_MODEL]);
  assert.deepEqual(judgeModels({ GEMINI_FALLBACK: "" }), [PRIMARY_MODEL]);
  assert.deepEqual(judgeModels({ GEMINI_FALLBACK: "nonsense" }), [PRIMARY_MODEL]);
  assert.deepEqual(judgeModels({ GEMINI_FALLBACK: "on" }), FLASH_LITE_CHAIN);
  assert.deepEqual(judgeModels({ GEMINI_FALLBACK: "TRUE" }), FLASH_LITE_CHAIN);
  assert.equal(fallbackEnabled({}), false);
});

test("by default a call that fails every retry on 3.5 fails; it never goes to 3.1", async () => {
  const { client, seen, sleeps } = fakeGemini({
    [PRIMARY_MODEL]: [status(503), status(503), new TypeError("fetch failed"), status(503)],
    [BACKUP_MODEL]: [answer({ tier: "A" })],
  });
  await assert.rejects(client.generate([{ text: "hi" }], {}), (e) => {
    assert.ok(e instanceof GeminiUnavailableError && !(e instanceof GeminiQuotaError));
    assert.match(e.message, /gemini-3\.5-flash-lite HTTP 503 after 3 retries/);
    return true;
  });
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL]);
  assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [10000, 30000, 60000]);
  assert.equal(client.counts.fallbacks, 0);
});

test("by default a spent 3.5 daily quota stops the run; it never goes to 3.1", async () => {
  const { client, seen } = fakeGemini({ [PRIMARY_MODEL]: [dailyQuota()], [BACKUP_MODEL]: [answer({ tier: "A" })] });
  await assert.rejects(client.generate([{ text: "hi" }], {}), /daily quota used up; waiting for tomorrow's quota/);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL]);
});

test("503s and network errors retry the same model with backoff, without falling back", async () => {
  const { client, seen, sleeps } = fakeGemini(
    {
      [PRIMARY_MODEL]: [status(503), new TypeError("fetch failed"), answer({ tier: "A" })],
      [BACKUP_MODEL]: [answer({ tier: "B" })],
    },
    { models: FLASH_LITE_CHAIN }
  );
  const { result, model, fallback } = await client.generate([{ text: "hi" }], {});
  assert.deepEqual([result, model, fallback], [{ tier: "A" }, PRIMARY_MODEL, false]);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL]);
  assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [10000, 30000]);
});

// The experiment chain (GEMINI_FALLBACK=on): kept for labelled experiments.
test("experiment chain: when the last retry still fails, that one call goes to the backup; the next call is back on 3.5", async () => {
  const { client, seen, records } = fakeGemini(
    {
      [PRIMARY_MODEL]: [status(503), status(503), status(503), status(503), answer({ tier: "S" })],
      [BACKUP_MODEL]: [answer({ tier: "A" })],
    },
    { models: FLASH_LITE_CHAIN }
  );
  const first = await client.generate([{ text: "1" }], {});
  assert.deepEqual([first.model, first.fallback], [BACKUP_MODEL, true]);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL, BACKUP_MODEL]);
  const second = await client.generate([{ text: "2" }], {});
  assert.equal(second.model, PRIMARY_MODEL);
  assert.equal(client.activeModel, PRIMARY_MODEL);
  assert.deepEqual(
    records.map((r) => [r.model, r.status, r.retry, r.fallback]),
    [
      [PRIMARY_MODEL, 503, false, false],
      [PRIMARY_MODEL, 503, true, false],
      [PRIMARY_MODEL, 503, true, false],
      [PRIMARY_MODEL, 503, true, false],
      [BACKUP_MODEL, 200, true, true],
      [PRIMARY_MODEL, 200, false, false],
    ]
  );
  assert.equal(client.counts.fallbacks, 1);
});

test("experiment chain: a spent daily quota moves the rest of the run to the backup model", async () => {
  const { client, seen } = fakeGemini(
    {
      [PRIMARY_MODEL]: [dailyQuota()],
      [BACKUP_MODEL]: [answer({ tier: "A" }), answer({ tier: "B" })],
    },
    { models: FLASH_LITE_CHAIN }
  );
  assert.equal((await client.generate([{ text: "1" }], {})).model, BACKUP_MODEL);
  assert.equal(client.activeModel, BACKUP_MODEL);
  assert.equal((await client.generate([{ text: "2" }], {})).model, BACKUP_MODEL);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL, BACKUP_MODEL, BACKUP_MODEL]);
});

test("a per-minute 429 slows down and retries 3.5, waiting Google's RetryInfo delay", async () => {
  const { client, seen, sleeps } = fakeGemini({
    [PRIMARY_MODEL]: [perMinute("7s"), answer({ tier: "A" })],
    [BACKUP_MODEL]: [answer({ tier: "B" })],
  });
  const { model } = await client.generate([{ text: "hi" }], {});
  assert.equal(model, PRIMARY_MODEL);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL, PRIMARY_MODEL]);
  assert.ok(sleeps.includes(7000), `waited ${sleeps}`);
});

test("experiment chain with onDailyQuota stop: a spent daily quota stops instead of using the backup", async () => {
  const { client, seen } = fakeGemini(
    { [PRIMARY_MODEL]: [dailyQuota()], [BACKUP_MODEL]: [answer({ tier: "A" })] },
    { models: FLASH_LITE_CHAIN, onDailyQuota: "stop" }
  );
  await assert.rejects(client.generate([{ text: "hi" }], {}), GeminiQuotaError);
  assert.deepEqual(seen.map((x) => x.model), [PRIMARY_MODEL]);
});

test("per-minute 429s that never clear stop the call as unavailable", async () => {
  const { client } = fakeGemini({ [PRIMARY_MODEL]: Array.from({ length: 4 }, () => perMinute("1s")) }, { maxSlowdowns: 3 });
  await assert.rejects(client.generate([{ text: "hi" }], {}), GeminiUnavailableError);
});

test("experiment chain: both daily quotas spent: GeminiQuotaError, so the run stops cleanly", async () => {
  const { client } = fakeGemini({ [PRIMARY_MODEL]: [dailyQuota()], [BACKUP_MODEL]: [dailyQuota()] }, { models: FLASH_LITE_CHAIN });
  await assert.rejects(client.generate([{ text: "hi" }], {}), GeminiQuotaError);
});

test("experiment chain: the backup failing too after the retries: GeminiUnavailableError", async () => {
  const { client, seen } = fakeGemini(
    {
      [PRIMARY_MODEL]: [status(503), status(503), status(503), status(503)],
      [BACKUP_MODEL]: [status(503)],
    },
    { models: FLASH_LITE_CHAIN }
  );
  await assert.rejects(client.generate([{ text: "hi" }], {}), GeminiUnavailableError);
  assert.equal(seen.length, 5);
});

test("every request reports tokens and latency to onRequest", async () => {
  const { client, records } = fakeGemini({ [PRIMARY_MODEL]: [answer({ tier: "A" }, { promptTokenCount: 900, candidatesTokenCount: 40 })] });
  await client.generate([{ text: "hi" }], {});
  assert.equal(records.length, 1);
  assert.equal(records[0].inputTokens, 900);
  assert.equal(records[0].outputTokens, 40);
  assert.equal(records[0].status, 200);
  assert.equal(typeof records[0].latencyMs, "number");
});

test("one limiter spaces every request evenly, retries included", async () => {
  let t = 0;
  const waits = [];
  const limiter = createLimiter({ rpm: 6, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  const { client } = fakeGemini(
    { [PRIMARY_MODEL]: [status(503), answer({}), answer({})] },
    { limiter, sleep: async (ms) => { t += ms; } }
  );
  await client.generate([{ text: "1" }], {});
  await client.generate([{ text: "2" }], {});
  // 6 per minute = one every 10s: the retry (after a 10s backoff) needed no
  // extra wait; the next call waited for its slot.
  assert.deepEqual(waits, [10000]);
});

test("429 bodies: daily quota vs per-minute, and the RetryInfo delay", async () => {
  assert.equal(isDailyQuota(await dailyQuota().text()), true);
  assert.equal(isDailyQuota(await perMinute().text()), false);
  assert.equal(retryDelayFrom(await perMinute("43s").text()), 43000);
  assert.equal(retryDelayFrom("{}"), null);
});

for (const [label, res] of [
  ["401", () => status(401, '{"error":{"status":"UNAUTHENTICATED"}}')],
  ["403", () => status(403, '{"error":{"status":"PERMISSION_DENIED"}}')],
  ["400 API_KEY_INVALID", () => status(400, '{"error":{"message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}')],
]) {
  test(`a rejected key (${label}) is fatal and never falls back`, async () => {
    const { client, seen } = fakeGemini({ [PRIMARY_MODEL]: [res()], [BACKUP_MODEL]: [answer({})] });
    await assert.rejects(client.generate([{ text: "hi" }], {}), GeminiAuthError);
    assert.deepEqual(seen.map((s) => s.model), [PRIMARY_MODEL]);
  });
}

test("a bad request fails the call without falling back", async () => {
  const { client, seen } = fakeGemini({
    [PRIMARY_MODEL]: [status(400, '{"error":{"message":"Invalid JSON payload"}}')],
    [BACKUP_MODEL]: [answer({})],
  });
  await assert.rejects(client.generate([{ text: "hi" }], {}), (e) => {
    assert.ok(!(e instanceof GeminiAuthError));
    assert.match(e.message, /HTTP 400/);
    return true;
  });
  assert.deepEqual(seen.map((s) => s.model), [PRIMARY_MODEL]);
});

test("one logical rater id for the flash-lite chain, a separate one for other models", () => {
  assert.equal(raterIdFor(FLASH_LITE_CHAIN), FLASH_LITE_RATER_ID);
  assert.equal(raterIdFor([BACKUP_MODEL]), FLASH_LITE_RATER_ID);
  assert.equal(raterIdFor(["gemini-3.5-pro"]), "ai:gemini-3.5-pro");
});

test("prepareAiVotes folds per-model AI votes into the logical rater, idempotently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-votes-"));
  const db = createClient({ url: `file:${path.join(dir, "votes.db")}` });
  try {
    await db.execute(`CREATE TABLE votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
      pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL)`);
    await db.execute("CREATE UNIQUE INDEX votes_rater_pair_idx ON votes (rater_id, pair_key)");
    await db.batch([
      "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('a', 'b', 'a\nb', 'ai', 'ai:gemini-3.1-flash-lite')",
      "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('c', 'd', 'c\nd', 'ai', 'ai:gemini-3.1-flash-lite')",
      "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('a', 'b', 'a\nb', 'human', 'gh:1')",
    ]);

    assert.equal(await prepareAiVotes(db), 2);
    assert.equal(await prepareAiVotes(db), 0, "second run changes nothing");

    const rows = (await db.execute("SELECT rater_type, rater_id, model FROM votes ORDER BY id")).rows.map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { rater_type: "ai", rater_id: FLASH_LITE_RATER_ID, model: "gemini-3.1-flash-lite" },
      { rater_type: "ai", rater_id: FLASH_LITE_RATER_ID, model: "gemini-3.1-flash-lite" },
      { rater_type: "human", rater_id: "gh:1", model: null },
    ]);
    // The unique index now stops the backup model from re-voting a judged pair.
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, model) VALUES ('b', 'a', 'a\nb', 'ai', ?, ?)",
        args: [FLASH_LITE_RATER_ID, PRIMARY_MODEL],
      }),
      /UNIQUE constraint failed/
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
