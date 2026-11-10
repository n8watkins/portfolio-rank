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
  FLASH_LITE_CHAIN,
  GeminiAuthError,
  PRIMARY_MODEL,
} from "../pipeline/gemini.mjs";
import { FLASH_LITE_RATER_ID, prepareAiVotes, raterIdFor } from "../pipeline/ai-votes.mjs";

const KEY = "AQ.test-key-not-real";
const answer = (obj) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
  const client = createGemini({
    apiKey: KEY,
    rpm: 60000,
    retryDelaysMs: [0],
    sleep: async () => {},
    log: () => {},
    fetchImpl,
    ...opts,
  });
  return { client, seen };
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

test("defaults to 3.5 Flash-Lite with 3.1 Flash-Lite as the backup", () => {
  assert.deepEqual(FLASH_LITE_CHAIN, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
});

for (const [label, failure] of [
  ["rate limited (429)", () => status(429)],
  ["overloaded (503)", () => status(503)],
  ["unreachable (network error)", () => new TypeError("fetch failed")],
]) {
  test(`falls back to the backup model when the primary is ${label}`, async () => {
    const { client, seen } = fakeGemini({
      [PRIMARY_MODEL]: [failure()],
      [BACKUP_MODEL]: [answer({ tier: "A" })],
    });
    const { result, model } = await client.generate([{ text: "hi" }], {});
    assert.deepEqual(result, { tier: "A" });
    assert.equal(model, BACKUP_MODEL, "reports the model that actually answered");
    assert.deepEqual(seen.map((s) => s.model), [PRIMARY_MODEL, BACKUP_MODEL]);
    assert.match(client.summary(), /answered by gemini-3.1-flash-lite 1/);
  });
}

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

test("retries the whole chain when every model is unavailable, then gives up", async () => {
  const { client, seen } = fakeGemini({
    [PRIMARY_MODEL]: [status(429), status(429)],
    [BACKUP_MODEL]: [status(503), status(429)],
  });
  await assert.rejects(client.generate([{ text: "hi" }], {}), /gemini unavailable/);
  assert.deepEqual(seen.map((s) => s.model), [PRIMARY_MODEL, BACKUP_MODEL, PRIMARY_MODEL, BACKUP_MODEL]);
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
