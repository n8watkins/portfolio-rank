// The rating engine's database side, the recompute script and the new
// comparison job (pipeline/compare.mjs), offline on throwaway databases.
// The job runs as a child process with fetch replaced
// (tests/helpers/mock-fetch.mjs): Gemini and R2 are stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import {
  comparisonsToday,
  detectPageChanges,
  ensureRankingSchema,
  inputDigest,
  insertComparison,
  loadInput,
  pageFingerprint,
  recordFingerprint,
  syncVotes,
} from "../lib/ranking/store.mjs";
import feed from "../data/feed.json" with { type: "json" };

const grade = (tier) => JSON.stringify({ tier, is_portfolio: true, quality_score: 3.5, rubric_version: 2, model: "gemini-3.5-flash-lite" });

async function setup({ sites = 6 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ranking-"));
  const dbFile = path.join(dir, "db.sqlite");
  const db = createClient({ url: `file:${dbFile}` });
  await ensureRosterSchema(db);
  // The vote table as the app creates it (lib/db.ts), with the judge's model column.
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`,
  ]);
  const tiers = ["S", "A", "B", "C", "D", "B"];
  const urls = feed.slice(0, sites).map((p) => p.url);
  for (const [i, url] of urls.entries()) {
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, meta, page_text)
            VALUES (?, ?, 'live', ?, '2026-11-01 00:00:00', ?, ?, 'Hello, I build things.')`,
      args: [url, `Person ${i}`, `k${i}`, grade(tiers[i % tiers.length]), JSON.stringify({ domHash: `d${i}`, classHash: `c${i}` })],
    });
  }
  return { dir, dbFile, db, urls };
}

function run(script, dir, dbFile, args = [], env = {}) {
  const log = path.join(dir, `gemini-${Math.random().toString(16).slice(2)}.log`);
  const summary = path.join(dir, `summary-${Math.random().toString(16).slice(2)}.md`);
  const child = spawn(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", script, ...args], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${dbFile}`,
      TURSO_AUTH_TOKEN: "",
      GEMINI_API_KEY: "test-key-not-real",
      SHOTS_BASE_URL: "https://shots.test",
      GITHUB_STEP_SUMMARY: summary,
      MOCK_LOG: log,
      RANKING_V2: "",
      GEMINI_FALLBACK: "off",
      RANKING_BUDGET: "",
      RANKING_BATCHED_COUNTS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) =>
    child.on("exit", (code) =>
      resolve({
        code,
        out,
        summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
        requests: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
      })
    )
  );
}

test("schema: additive and idempotent", async () => {
  const { db } = await setup();
  await ensureRankingSchema(db);
  await ensureRankingSchema(db);
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  for (const t of ["comparisons", "site_ratings", "rank_history", "site_fingerprints", "rating_resets", "ranking_runs", "votes", "portfolios"]) assert.ok(tables.includes(t), t);
});

test("syncVotes: human and AI votes are mirrored with their models, practice votes never; claims and undos follow", async () => {
  const { db, urls } = await setup();
  await ensureRankingSchema(db);
  const [a, b, c] = urls;
  await db.batch([
    { sql: "INSERT INTO votes (winner, loser, rater_type, rater_id, created_at, starred) VALUES (?, ?, 'human', 'u1', '2026-11-01 10:00:00', 1)", args: [a, b] },
    { sql: "INSERT INTO votes (winner, loser, rater_type, rater_id, created_at, model) VALUES (?, ?, 'ai', 'ai:flash-lite', '2026-11-02 10:00:00', 'gemini-3.1-flash-lite')", args: [b, c] },
    { sql: "INSERT INTO votes (winner, loser, rater_type, rater_id, created_at) VALUES (?, ?, 'anon', 'anon:x', '2026-11-03 10:00:00')", args: [c, a] },
  ]);
  assert.deepEqual(await syncVotes(db), { imported: 2, removed: 0 });
  assert.deepEqual(await syncVotes(db), { imported: 0, removed: 0 }, "a second sync changes nothing");
  const rows = (await db.execute("SELECT * FROM comparisons ORDER BY created_at")).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rater_type, "human");
  assert.equal(rows[0].starred, 1);
  assert.equal(rows[0].created_at, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(JSON.parse(String(rows[0].ranking)), [[a], [b]]);
  assert.equal(rows[0].shown, null, "the order shown was never recorded for old votes");
  assert.equal(rows[1].model, "gemini-3.1-flash-lite");
  assert.equal(rows[1].prompt_version, "legacy-pairwise");
  // A practice vote claimed at sign-in becomes human and is picked up; an undone vote goes.
  await db.execute("UPDATE votes SET rater_type = 'human', rater_id = 'u2' WHERE rater_type = 'anon'");
  await db.execute({ sql: "DELETE FROM votes WHERE winner = ? AND loser = ?", args: [a, b] });
  const again = await syncVotes(db);
  assert.equal(again.removed, 1);
  const after = (await db.execute("SELECT rater_id FROM comparisons ORDER BY created_at")).rows.map((r) => r.rater_id);
  assert.deepEqual(after, ["ai:flash-lite", "u2"]);
});

test("change detection: the first fingerprint is a baseline; a new one adds a reset", async () => {
  const { db, urls } = await setup();
  await ensureRankingSchema(db);
  assert.equal(await detectPageChanges(db), 0, "first sight is a baseline");
  assert.equal(await detectPageChanges(db), 0, "unchanged pages add nothing");
  await db.execute({ sql: "UPDATE portfolios SET meta = ?, captured_at = '2026-11-09 08:00:00' WHERE url = ?", args: [JSON.stringify({ domHash: "new", classHash: "new" }), urls[4]] });
  assert.equal(await detectPageChanges(db), 1);
  const resets = (await db.execute("SELECT url, at, reason FROM rating_resets")).rows;
  assert.deepEqual(resets.map((r) => [r.url, r.at, r.reason]), [[urls[4], "2026-11-09T08:00:00.000Z", "page_changed"]]);
  assert.equal(await recordFingerprint(db, "https://x.dev", null), false);
  assert.equal(pageFingerprint("not json"), null);
  assert.equal(pageFingerprint({}), null);
  assert.equal(pageFingerprint({ domHash: "a" }).length, 20);
});

test("recompute script: rebuilds the views into site_ratings and rank_history; read-only writes nothing; an export reproduces it", async () => {
  const { dir, dbFile, db, urls } = await setup();
  await db.execute({ sql: "INSERT INTO votes (winner, loser, rater_type, rater_id, created_at) VALUES (?, ?, 'human', 'u1', '2026-11-03 10:00:00')", args: [urls[4], urls[0]] });
  // Read-only first: no tables are created.
  const ro = await run("scripts/recompute-ratings.mjs", dir, dbFile, ["--read-only"]);
  assert.equal(ro.code, 0, ro.out);
  assert.match(ro.summary, /## merged/);
  const before = (await db.execute("SELECT name FROM sqlite_master WHERE name = 'site_ratings'")).rows;
  assert.equal(before.length, 0);

  await ensureRankingSchema(db);
  await insertComparison(db, {
    created_at: "2026-11-04T13:00:00Z",
    rater_type: "ai",
    model: "gemini-3.5-flash-lite",
    prompt_version: "compare-v1",
    method: "one_on_one",
    shown: [urls[1], urls[0]],
    ranking: [[urls[1]], [urls[0]]],
    match_seed: "2026-11-04:0:0",
    match_kind: "close",
  });
  const exportFile = path.join(dir, "export.json");
  const report = path.join(dir, "report.json");
  const r = await run("scripts/recompute-ratings.mjs", dir, dbFile, ["--export", exportFile, "--report", report]);
  assert.equal(r.code, 0, r.out);
  const views = (await db.execute("SELECT view, COUNT(*) AS n FROM site_ratings GROUP BY view ORDER BY view")).rows.map((x) => [x.view, Number(x.n)]);
  assert.deepEqual(views, [["ai", 6], ["merged", 6], ["people", 6]]);
  const people = (await db.execute("SELECT url FROM site_ratings WHERE view = 'people' AND rank = 1")).rows[0].url;
  assert.equal(people, urls[4], "the only human vote decides People");
  const ai = (await db.execute("SELECT url FROM site_ratings WHERE view = 'ai' AND rank = 1")).rows[0].url;
  assert.equal(ai, urls[0], "the S site still leads AI after one loss to an A");
  assert.ok(Number((await db.execute("SELECT COUNT(*) AS n FROM rank_history")).rows[0].n) > 0);
  const run1 = (await db.execute("SELECT input_digest, settings FROM ranking_runs")).rows[0];
  assert.match(String(run1.settings), /plackett-luce/);

  // Anyone with the export gets the same boards.
  const fromExport = await run("scripts/recompute-ratings.mjs", dir, "/nonexistent", ["--from", exportFile, "--report", path.join(dir, "r2.json")]);
  assert.equal(fromExport.code, 0, fromExport.out);
  const a = JSON.parse(fs.readFileSync(report, "utf8"));
  const b = JSON.parse(fs.readFileSync(path.join(dir, "r2.json"), "utf8"));
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, run1.input_digest);
  assert.deepEqual(a.views, b.views);
  const exported = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  assert.equal(inputDigest(exported), a.digest);
  assert.deepEqual(exported.comparisons.find((c) => c.method === "one_on_one" && c.rater_type === "ai").shown, [urls[1], urls[0]]);

  // A second run is idempotent: same boards, nothing duplicated.
  const again = await run("scripts/recompute-ratings.mjs", dir, dbFile, []);
  assert.equal(again.code, 0, again.out);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM comparisons")).rows[0].n), 2);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM site_ratings")).rows[0].n), 18);
});

test("compare job: off by default, it touches neither Gemini nor the database", async () => {
  const { dir, dbFile, db } = await setup();
  const r = await run("pipeline/compare.mjs", dir, dbFile);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RANKING_V2 is not "true"/);
  assert.equal(r.requests.length, 0);
  const t = (await db.execute("SELECT name FROM sqlite_master WHERE name = 'comparisons'")).rows;
  assert.equal(t.length, 0);
});

test("compare job: stores one-on-one and batched comparisons with their full record, within today's budget, on 3.5 only", async () => {
  const { dir, dbFile, db } = await setup();
  const env = {
    RANKING_V2: "true",
    RANKING_BUDGET: JSON.stringify({ one_on_one: 3, batched: 1 }),
    MOCK_GEMINI: JSON.stringify([{ json: { winner: "A", reason: "a" } }, { json: { winner: "B", reason: "b" } }, { json: { winner: "skip", reason: "c" } }, { json: { order: ["E", "D", "C", "B", "A"], reason: "d" } }]),
  };
  const r = await run("pipeline/compare.mjs", dir, dbFile, ["--rpm", "60000"], env);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.requests.length, 4);
  assert.ok(r.requests.every((q) => q.model === "gemini-3.5-flash-lite"));
  assert.deepEqual(r.requests.map((q) => q.images), [2, 2, 2, 5]);
  const rows = (await db.execute("SELECT * FROM comparisons ORDER BY id")).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.rater_type, "ai");
    assert.equal(row.model, "gemini-3.5-flash-lite");
    assert.ok(row.match_seed && row.match_kind && row.created_at && row.shown);
  }
  const [first, second, skipped, batch] = rows;
  assert.equal(first.prompt_version, "compare-v1");
  assert.deepEqual(JSON.parse(String(first.ranking))[0], [JSON.parse(String(first.shown))[0]], "A is the site shown first");
  assert.deepEqual(JSON.parse(String(second.ranking))[0], [JSON.parse(String(second.shown))[1]]);
  assert.equal(skipped.outcome, "skip");
  assert.equal(skipped.ranking, null);
  assert.equal(batch.method, "batched");
  assert.equal(batch.prompt_version, "batch-v1");
  const shown = JSON.parse(String(batch.shown));
  assert.deepEqual(JSON.parse(String(batch.ranking)), [...shown].reverse().map((u) => [u]));
  assert.deepEqual(await comparisonsToday(db, { model: "gemini-3.5-flash-lite" }), { one_on_one: 3, batched: 1 });
  assert.match(r.summary, /AI comparisons \(ranking v2\)/);

  // Today's budget is used: a second run asks nothing.
  const again = await run("pipeline/compare.mjs", dir, dbFile, ["--rpm", "60000"], env);
  assert.equal(again.code, 0, again.out);
  assert.equal(again.requests.length, 0);
  // And the stored comparisons go into the boards.
  const input = await loadInput(db);
  assert.equal(input.comparisons.length, 4);
});

test("compare job: a spent 3.5 quota is deferred, not failed, and never falls back to 3.1", async () => {
  const { dir, dbFile, db } = await setup();
  const quota = { status: 429, raw: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }) };
  const r = await run("pipeline/compare.mjs", dir, dbFile, ["--rpm", "60000"], {
    RANKING_V2: "true",
    RANKING_BUDGET: JSON.stringify({ one_on_one: 3, batched: 0 }),
    MOCK_GEMINI: JSON.stringify([quota]),
  });
  // Same rule as judge.mjs (#63): nothing compared because the quota is
  // spent is waiting for tomorrow, so the run passes.
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /daily quota/);
  assert.match(r.summary, /waiting for tomorrow|wait for tomorrow/);
  assert.match(r.summary, /\| 0 \| 0 \| 0 \| 0 \| 0 \| 3 \|/, "three comparisons deferred, none failed");
  assert.equal(r.requests.length, 1, "one request, then it stops");
  assert.ok(r.requests.every((q) => q.model === "gemini-3.5-flash-lite"), "never 3.1");
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM comparisons")).rows[0].n), 0);
});

test("compare job: with GEMINI_FALLBACK on, an answer from the backup model is stored as an experiment and never rates sites", async () => {
  const { dir, dbFile, db } = await setup();
  const quota = { status: 429, raw: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }) };
  const r = await run("pipeline/compare.mjs", dir, dbFile, ["--rpm", "60000"], {
    RANKING_V2: "true",
    GEMINI_FALLBACK: "on",
    RANKING_BUDGET: JSON.stringify({ one_on_one: 1, batched: 0 }),
    MOCK_GEMINI: JSON.stringify([quota, { json: { winner: "A", reason: "a" } }]),
  });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.requests.map((q) => q.model), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  const [row] = (await db.execute("SELECT model, experiment FROM comparisons")).rows;
  assert.deepEqual([row.model, row.experiment], ["gemini-3.1-flash-lite", "backup-model"]);
});
