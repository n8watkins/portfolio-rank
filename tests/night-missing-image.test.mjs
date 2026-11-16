// A site whose screenshot is gone for good must not stall the end-of-day run
// (pipeline/night.mjs), and a run that ends on the Workflow's batch limit must
// say so. Same offline setup as night.test.mjs: local database, simulated
// clock, mocked Gemini.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { budgetPlan } from "../pipeline/budget.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { finishNight, madeProgress, planNight, runBatch, stageTally, startNight } from "../pipeline/night.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import feed from "../data/feed.json" with { type: "json" };

const answer = { is_portfolio: true, tier: "B", ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 3, note: "fine" }])) };
const facts = JSON.stringify({ source: "http", measured_at: "2026-11-01T00:00:00Z", github: true });
const T0 = Date.parse("2026-11-11T04:30:00Z"); // 20:30 Pacific on 2026-11-10

// `kind` "changed": a graded site whose page changed (grade_changed queue);
// "old31": graded by the backup model (regrade queue). Index 0 has no image.
async function setup(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-img-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  const urls = [];
  for (let i = 0; i < 3; i++) {
    const url = feed[i].url;
    urls.push(url);
    const grade =
      kind === "changed"
        ? { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, rubric_version: 2, judged_at: "2026-11-01T00:00:00.000Z" }
        : { tier: "B", is_portfolio: true, model: BACKUP_MODEL, judged_at: `2026-10-0${1 + i}T00:00:00.000Z` };
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, page_text, facts, meta) VALUES (?, ?, 'live', ?, ?, ?, 'Hi', ?, ?)`,
      // Newest capture first, so the site without an image is the first one every batch asks for.
      args: [url, `Person ${i}`, `k${i}`, `2026-11-0${9 - i} 00:00:00`, JSON.stringify(grade), facts, JSON.stringify({ motion: false })],
    });
    if (kind === "changed") await db.execute({ sql: "INSERT INTO rating_resets (url, at, reason) VALUES (?, '2026-11-09T00:00:00.000Z', 'page_changed')", args: [url] });
  }
  return { db, urls };
}

function context(db) {
  const clock = { t: T0 };
  let requests = 0;
  // How many times each site's screenshot was asked for, by its key.
  const looked = {};
  const fetchImpl = async () => {
    requests++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6 } }), { status: 200 });
  };
  return {
    clock,
    requests: () => requests,
    looked,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(JSON.stringify({ stages: { regrade: { cap: 300 } } })),
      quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
      rpm: 8,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: () => {},
      fetchImpl,
      // The first site's screenshot is gone for good; the others are fine.
      image: async (key) => {
        looked[key] = (looked[key] ?? 0) + 1;
        return key === "k0" ? "missing" : { inline_data: { mime_type: "image/jpeg", data: "AAAA" } };
      },
      flags: { rankingV2: false, rubricRegrade: false, ranking: rankingConfig({}) },
      runId: "test",
    },
  };
}

// The Workflow's loop (worker/night.ts) with a batch limit.
async function drive(ctx, clock, maxBatches) {
  let state = await startNight(ctx);
  state = await planNight(ctx, state);
  let batches = 0;
  for (; batches < maxBatches && !state.done; batches++) {
    const r = await runBatch(ctx, state);
    state = r.state;
    if (r.pauseMs) clock.t += r.pauseMs;
  }
  return { state, batches, ...(await finishNight(ctx, state)) };
}

for (const [kind, stageKey] of [["changed", "grade_changed"], ["old31", "regrade"]]) {
  test(`${stageKey}: a site with no image is set aside once, the stage grades the rest and ends`, async () => {
    const { db, urls } = await setup(kind);
    const { ctx, clock, requests, looked } = context(db);
    // 40 is only this test's patience: before the fix the run was still on
    // the same site when it ran out. A whole night of three sites needs a
    // handful of batches (one or two per stage that has work or closes).
    const r = await drive(ctx, clock, 40);
    assert.ok(r.state.done, `the run ends (took ${r.batches} batches)`);
    assert.ok(r.batches <= 12, `a night of three sites takes a handful of batches, not ${r.batches}`);
    assert.equal(looked.k0, 1, "the site without a screenshot is looked at once tonight, never again");
    assert.equal(r.status, "complete");
    const stage = r.summary.stages.find((x) => x.key === stageKey);
    assert.equal(stage.noImage, 1);
    assert.equal(stage.done, 2);
    assert.equal(stage.requests, 2);
    assert.equal(requests(), 2 + (r.summary.stages.find((x) => x.key === "content")?.requests ?? 0));
    assert.match(r.markdown, /set aside for a missing image/);
    // The two sites with images were graded on 3.5.
    const graded = (await db.execute("SELECT url, json_extract(ai_rubric, '$.model') AS m FROM portfolios")).rows;
    assert.equal(graded.filter((g) => g.m === PRIMARY_MODEL).length, kind === "changed" ? 3 : 2);
    assert.ok(urls.length === 3);
  });
}

test("a run that uses up the Workflow's batch limit is reported as stopped, not complete", async () => {
  const { db } = await setup("changed");
  const { ctx, clock } = context(db);
  // Too few batches to finish: three stages, each needing more than one batch.
  const r = await drive(ctx, clock, 1);
  assert.equal(r.state.done, false);
  assert.equal(r.status, "stopped");
  assert.match(r.summary.stopped, /batch limit/);
  assert.match(r.markdown, /Status: \*\*stopped\*\*\. Stopped: .*batch limit/);
  const row = (await db.execute("SELECT status FROM night_runs")).rows[0];
  assert.equal(String(row.status), "stopped");
  assert.ok(r.summary.stages.some((x) => x.result === "not reached"), "the stages after it say not reached");
});

test("a batch must get somewhere: an item counted or set aside, or a request spent", () => {
  const stage = { ok: 2, failed: 1, skipped: 0, noImage: 1, tried: ["a", "b"] };
  const before = stageTally(stage);
  assert.equal(before, 6);
  assert.equal(madeProgress(before, stageTally(stage), 0), false, "nothing moved and nothing was spent");
  assert.equal(madeProgress(before, stageTally({ ...stage, ok: 3 }), 0), true, "an item was graded");
  assert.equal(madeProgress(before, stageTally({ ...stage, tried: ["a", "b", "c"] }), 0), true, "an item was set aside");
  assert.equal(madeProgress(before, stageTally({ ...stage, noImage: 2 }), 0), true);
  assert.equal(madeProgress(before, stageTally(stage), 1), true, "a request was spent");
  assert.equal(stageTally({}), 0);
});

test("the Workflow's batch ceiling is a few times a full night, not thirty", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../worker/night.ts"), "utf8");
  const max = Number(/export const MAX_BATCHES = (\d+);/.exec(src)?.[1]);
  // A full night is about 100 batches (worker/night.ts); the ceiling leaves room, but not for a stuck run.
  assert.ok(max >= 150 && max <= 300, `MAX_BATCHES is ${max}`);
});
