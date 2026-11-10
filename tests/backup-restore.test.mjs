// The nightly backup and its restore (scripts/backup-db.mjs,
// scripts/restore-db.mjs, docs/ASSUMPTIONS.md section G), end to end on
// throwaway files: every table the site needs comes back, row for row, with
// its indexes and the vote counters' triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureRankingSchema, insertComparison } from "../lib/ranking/store.mjs";
import { ensureGeminiLog, createRequestLog } from "../pipeline/gemini-log.mjs";
import { ensureNightSchema } from "../pipeline/night.mjs";
import { ensureRubricHistory } from "../pipeline/rubric-history.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureGeminiDaily } from "../pipeline/retention.mjs";
import { SKIP_TABLES } from "../scripts/lib/snapshot.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
const file = (name) => path.join(dir, name);

function run(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

async function populated() {
  const db = createClient({ url: `file:${file("prod.db")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  await ensureRankingSchema(db);
  await ensureGeminiLog(db);
  await ensureGeminiDaily(db);
  await ensureNightSchema(db);
  await ensureRubricHistory(db);
  await db.batch([
    "INSERT INTO portfolios (url, name, status, shot_key, ai_rubric, page_text, meta) VALUES ('https://a.dev', 'A', 'live', 'ka', '{\"tier\":\"A\"}', 'Hello', '{\"domHash\":\"x\"}')",
    "INSERT INTO portfolios (url, name, status) VALUES ('https://b.dev', 'B', 'live')",
    "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES ('https://a.dev', 'https://b.dev', 'a|b', 'human', 'r1', 1)",
    "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('https://b.dev', 'https://a.dev', 'a|b', 'human', 'r2')",
    "INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1216, 2)",
    "INSERT INTO likes (rater_id, url) VALUES ('r1', 'https://a.dev')",
    "INSERT INTO lists (owner, name, slug) VALUES ('gh:1', 'Faves', 'faves-1')",
    "INSERT INTO list_items (list_id, url) VALUES (1, 'https://a.dev')",
    "INSERT INTO cache (k, v, at) VALUES ('psi:x', '{}', 1)",
    "INSERT INTO matchups (rater_id, pair_key, issued_at, window_start, draws) VALUES ('r1', 'a|b', 1, 1, 1)",
    "INSERT INTO night_runs (night, started_at, status) VALUES ('2026-11-09', '2026-11-10T04:30:00Z', 'done')",
    "INSERT INTO gemini_daily (day, model, job, outcome, requests) VALUES ('2026-08-01', 'm', 'grade-new', 'ok', 3)",
  ]);
  await insertComparison(db, { created_at: "2026-11-09T05:00:00Z", rater_type: "ai", model: "m", method: "one_on_one", shown: ["https://a.dev", "https://b.dev"], ranking: [["https://a.dev"], ["https://b.dev"]], source: "s1" });
  await createRequestLog({ db, job: "grade-new" }).record({ at: "2026-11-09T05:00:00Z", model: "m", status: 200, finishReason: "STOP" });
  return db;
}

test("backup then restore brings back every table but the transient ones, row for row, with counters and triggers", async () => {
  const prod = await populated();
  const snapshot = file("snap.json.gz");
  const b = run("scripts/backup-db.mjs", ["--out", snapshot], { TURSO_DATABASE_URL: `file:${file("prod.db")}` });
  assert.equal(b.code, 0, b.out);
  for (const t of ["comparisons", "likes", "lists", "list_items", "gemini_requests", "gemini_daily", "night_runs", "rubric_history", "vote_totals", "star_counts", "site_ratings", "portfolios"]) {
    assert.match(b.out, new RegExp(`\\b${t}:\\d+`), `${t} is in the snapshot`);
  }
  for (const t of SKIP_TABLES) assert.doesNotMatch(b.out, new RegExp(`\\b${t}:`));

  // Refuses production, and a database that is not empty.
  assert.notEqual(run("scripts/restore-db.mjs", [snapshot], { RESTORE_DATABASE_URL: `file:${file("prod.db")}`, TURSO_DATABASE_URL: `file:${file("prod.db")}` }).code, 0);
  assert.notEqual(run("scripts/restore-db.mjs", [snapshot], { RESTORE_DATABASE_URL: `file:${file("prod.db")}` }).code, 0);

  const r = run("scripts/restore-db.mjs", [snapshot], { RESTORE_DATABASE_URL: `file:${file("restored.db")}` });
  assert.equal(r.code, 0, r.out);
  const back = createClient({ url: `file:${file("restored.db")}` });
  const tables = async (db) => (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((x) => String(x.name));
  const want = (await tables(prod)).filter((t) => !SKIP_TABLES.has(t));
  const got = await tables(back);
  for (const t of want) {
    assert.ok(got.includes(t), `${t} restored`);
    const dump = async (db) => JSON.stringify((await db.execute(`SELECT * FROM "${t}" ORDER BY 1, 2`)).rows);
    assert.equal(await dump(back), await dump(prod), `${t} rows match`);
  }
  // The counters came back as saved, and their triggers keep counting.
  assert.equal(Number((await back.execute("SELECT n FROM vote_totals WHERE k = 'all'")).rows[0].n), 2);
  await back.execute("INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES ('https://a.dev', 'https://b.dev', 'a|b', 'human', 'r3', 1)");
  assert.equal(Number((await back.execute("SELECT n FROM vote_totals WHERE k = 'all'")).rows[0].n), 3);
  assert.equal(Number((await back.execute("SELECT n FROM star_counts WHERE url = 'https://a.dev'")).rows[0].n), 2);
  const indexes = async (db) => (await db.execute("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND tbl_name NOT IN ('cache', 'matchups') ORDER BY name")).rows.map((x) => String(x.name));
  assert.deepEqual(await indexes(back), await indexes(prod));
});

test("an old snapshot (votes, ratings and part of portfolios) still restores", async () => {
  const old = file("old.json.gz");
  fs.writeFileSync(
    old,
    gzipSync(
      JSON.stringify({
        exported_at: "2026-11-01T05:00:00Z",
        votes: [{ id: 1, winner: "https://a.dev", loser: "https://b.dev", pair_key: "a|b", rater_type: "human", rater_id: "r1", created_at: "2026-10-01 00:00:00", starred: 1 }],
        ratings: [{ url: "https://a.dev", elo: 1216, votes: 1, updated_at: "2026-10-01 00:00:00" }],
        portfolios: [{ url: "https://a.dev", name: "A", status: "live", reason: null, shot_key: "ka", ai_rubric: null, checked_at: null, captured_at: null }],
      })
    )
  );
  const r = run("scripts/restore-db.mjs", [old], { RESTORE_DATABASE_URL: `file:${file("old-restored.db")}` });
  assert.equal(r.code, 0, r.out);
  const db = createClient({ url: `file:${file("old-restored.db")}` });
  assert.equal(Number((await db.execute("SELECT n FROM vote_totals WHERE k = 'all'")).rows[0].n), 1);
  assert.equal(Number((await db.execute("SELECT n FROM star_counts WHERE url = 'https://a.dev'")).rows[0].n), 1);
});
