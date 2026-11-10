// Gemini monitoring (pipeline/gemini-log.mjs), grade history and the
// re-grade queue (pipeline/rubric-history.mjs), and the 3.1-vs-3.5
// comparison report (scripts/grade-compare.mjs). Offline: Gemini is a
// stand-in, the database a throwaway file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createRequestLog, dailyTotals, ensureGeminiLog, runSummary } from "../pipeline/gemini-log.mjs";
import { ensureRubricHistory, regradeQueue, replaceGradeStatements } from "../pipeline/rubric-history.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { buildPairs, compareGrades, compareMarkdown } from "../scripts/grade-compare.mjs";
import feed from "../data/feed.json" with { type: "json" };

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mon-"));
  const file = path.join(dir, "db.sqlite");
  return { dir, file, db: createClient({ url: `file:${file}` }) };
}

const axis = (score) => ({ score, note: "x" });
const grade = (model, tier, scores = 3, over = {}) => ({
  model,
  tier,
  is_portfolio: true,
  judged_at: "2026-10-01T00:00:00Z",
  visual_design: axis(scores),
  five_second_test: axis(scores),
  storytelling: axis(scores),
  writing: axis(scores),
  memorability: axis(scores),
  motion: axis(scores),
  ...over,
});

test("requests are written to gemini_requests and summarized per model with an estimated cost", async () => {
  const { db } = tempDb();
  await ensureGeminiLog(db);
  const log = createRequestLog({ db, job: "rubric", runId: "42" });
  const at = "2026-11-10T13:00:00.000Z";
  await log.record({ at, model: PRIMARY_MODEL, status: 503, reason: "HTTP 503", latencyMs: 900 });
  await log.record({ at, model: PRIMARY_MODEL, status: 200, reason: "ok", retry: true, latencyMs: 1200, inputTokens: 1_000_000, outputTokens: 100_000 });
  await log.record({ at, model: BACKUP_MODEL, status: 429, reason: "HTTP 429 daily quota", fallback: true });
  const rows = (await db.execute("SELECT job, run_id, model, status, retry, fallback, input_tokens FROM gemini_requests ORDER BY id")).rows;
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[1].job, rows[1].run_id, rows[1].retry, rows[1].input_tokens], ["rubric", "42", 1, 1000000]);
  const md = runSummary(log.rows, { [PRIMARY_MODEL]: { in: 0.1, out: 0.4 } });
  assert.match(md, new RegExp(`\\| ${PRIMARY_MODEL} \\| 2 \\| 1 \\| 1 \\| 0 \\| 0 \\| 1 \\| 0 \\| 1000000 \\| 100000 \\| \\$0\\.1400 \\|`));
  assert.match(md, new RegExp(`\\| ${BACKUP_MODEL} \\| 1 \\| 0 \\| 0 \\| 1 \\| 0 \\| 0 \\| 1 \\|`));
});

test("a failing request log never breaks the run", async () => {
  const log = createRequestLog({ db: { execute: async () => { throw new Error("db down"); } }, job: "rubric" });
  await log.record({ at: "2026-11-10T00:00:00Z", model: PRIMARY_MODEL, status: 200 });
  assert.equal(log.writeErrors, 1);
  assert.equal(log.rows.length, 1);
});

test("today's totals are counted against the daily quota, with a warning from 80%", async () => {
  const { db } = tempDb();
  await ensureGeminiLog(db);
  const log = createRequestLog({ db, job: "pairwise" });
  for (let i = 0; i < 8; i++) await log.record({ at: "2026-11-10T09:00:00.000Z", model: PRIMARY_MODEL, status: 200 });
  await log.record({ at: "2026-11-09T23:59:59.000Z", model: PRIMARY_MODEL, status: 200 }); // yesterday
  await log.record({ at: "2026-11-10T10:00:00.000Z", model: BACKUP_MODEL, status: 503 });
  const quota = { [PRIMARY_MODEL]: 10, [BACKUP_MODEL]: 5 };
  const t = await dailyTotals(db, { now: new Date("2026-11-10T20:00:00Z"), quota });
  assert.equal(t.used.get(PRIMARY_MODEL).n, 8);
  assert.deepEqual(t.warnings, [`${PRIMARY_MODEL} has used 8 of 10 requests today (80%)`]);
  assert.match(t.markdown, new RegExp(`\\| ${BACKUP_MODEL} \\| 1 \\| 0 \\| 5 \\| 20% \\|`));
  assert.match(t.markdown, /\*\*Warning:\*\*/);
});

test("replacing a grade keeps the old one in rubric_history", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  await ensureRubricHistory(db);
  const old = JSON.stringify(grade(BACKUP_MODEL, "B"));
  await db.execute({ sql: "INSERT INTO portfolios (url, ai_rubric) VALUES ('https://a.dev', ?)", args: [old] });
  await db.batch(replaceGradeStatements("https://a.dev", old, grade(PRIMARY_MODEL, "A"), new Date("2026-11-10T00:00:00Z")), "write");
  const h = (await db.execute("SELECT model, tier, is_portfolio, replaced_by_model, replaced_at FROM rubric_history")).rows[0];
  assert.deepEqual({ ...h }, { model: BACKUP_MODEL, tier: "B", is_portfolio: 1, replaced_by_model: PRIMARY_MODEL, replaced_at: "2026-11-10T00:00:00.000Z" });
  const now = JSON.parse((await db.execute("SELECT ai_rubric FROM portfolios")).rows[0].ai_rubric);
  assert.equal(now.model, PRIMARY_MODEL);
  // An error sentinel is not a grade: nothing goes to history.
  const stmts = replaceGradeStatements("https://b.dev", JSON.stringify({ error: "no_usable_captures" }), grade(PRIMARY_MODEL, "C"));
  assert.equal(stmts.length, 1);
});

test("the re-grade queue holds listed, healthy grades not made by 3.5, oldest first", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const add = (url, rubric, extra = "") =>
    db.execute({
      sql: `INSERT INTO portfolios (url, status, shot_key, ai_rubric${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, 'live', 'k', ?${extra ? ", ?" : ""})`,
      args: extra ? [url, JSON.stringify(rubric), extra.split("=")[1]] : [url, JSON.stringify(rubric)],
    });
  await add("https://new31.dev", grade(BACKUP_MODEL, "B", 3, { judged_at: "2026-10-05T00:00:00Z" }));
  await add("https://old31.dev", grade(BACKUP_MODEL, "B", 3, { judged_at: "2026-09-01T00:00:00Z" }));
  await add("https://nomodel.dev", grade(undefined, "C", 3, { judged_at: "2026-09-15T00:00:00Z" }));
  await add("https://done35.dev", grade(PRIMARY_MODEL, "A"));
  await add("https://down.dev", grade(BACKUP_MODEL, "B"), "health=down");
  await add("https://gone.dev", grade(BACKUP_MODEL, "B"), "delisted_at=2026-11-01");
  await db.execute(`INSERT INTO portfolios (url, status, shot_key, ai_rubric) VALUES ('https://sentinel.dev', 'live', 'k', '{"error":"no_usable_captures"}')`);
  const urls = (await regradeQueue(db, { primary: PRIMARY_MODEL, limit: 10 })).map((r) => r.url);
  assert.deepEqual(urls, ["https://old31.dev", "https://nomodel.dev", "https://new31.dev"]);
  assert.equal((await regradeQueue(db, { primary: PRIMARY_MODEL, limit: 0 })).length, 0);
});

test("the comparison report: tier agreement, per-axis difference, is_portfolio disagreement", () => {
  const history = [
    { url: "a", model: BACKUP_MODEL, replaced_by_model: PRIMARY_MODEL, rubric: JSON.stringify(grade(BACKUP_MODEL, "A", 4)) },
    { url: "b", model: BACKUP_MODEL, replaced_by_model: PRIMARY_MODEL, rubric: JSON.stringify(grade(BACKUP_MODEL, "S", 5)) },
    { url: "c", model: BACKUP_MODEL, replaced_by_model: PRIMARY_MODEL, rubric: JSON.stringify(grade(BACKUP_MODEL, "B", 3, { is_portfolio: false })) },
    // A --force re-grade of a 3.5 grade is not a 3.1-vs-3.5 pair.
    { url: "d", model: PRIMARY_MODEL, replaced_by_model: PRIMARY_MODEL, rubric: JSON.stringify(grade(PRIMARY_MODEL, "B")) },
  ];
  const current = new Map([
    ["a", JSON.stringify(grade(PRIMARY_MODEL, "A", 4))],
    ["b", JSON.stringify(grade(PRIMARY_MODEL, "B", 3))],
    ["c", JSON.stringify(grade(PRIMARY_MODEL, "C", 2))],
    ["d", JSON.stringify(grade(PRIMARY_MODEL, "B"))],
  ]);
  const r = compareGrades(buildPairs(history, current));
  assert.equal(r.pairs, 3);
  assert.equal(r.exact, 1); // A=A
  assert.equal(r.withinOne, 2); // A=A, B~C
  assert.equal(r.portfolioDisagree, 1);
  assert.equal(r.mae.visual_design, (0 + 2 + 1) / 3);
  const md = compareMarkdown(r);
  assert.match(md, /3 site\(s\) graded by both/);
  assert.match(md, /\| Same tier \| 33\.3% \(1\) \|/);
  assert.match(md, /\| visual_design \| 1\.00 \|/);
});

test("judge.mjs re-grades 3.1 grades with 3.5 when quota allows, keeps history, and logs every request", async () => {
  const { dir, file, db } = tempDb();
  await ensureRosterSchema(db);
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT, loser TEXT, pair_key TEXT,
       rater_type TEXT, rater_id TEXT, created_at TEXT DEFAULT (datetime('now')), delta INTEGER)`,
    `CREATE TABLE ratings (url TEXT PRIMARY KEY, elo INTEGER, votes INTEGER, updated_at TEXT)`,
  ]);
  const [a, b, c] = feed;
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at) VALUES (?, 'New', 'live', 'k1', datetime('now'))", args: [a.url] });
  for (const u of [b.url, c.url]) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric) VALUES (?, 'Old', 'live', 'k2', datetime('now'), ?)",
      args: [u, JSON.stringify(grade(BACKUP_MODEL, "B"))],
    });
  }
  const summary = path.join(dir, "summary.md");
  const child = spawn(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", "rubric", "--rpm", "60000"], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${file}`,
      TURSO_AUTH_TOKEN: "",
      GEMINI_API_KEY: "test-key-not-real",
      SHOTS_BASE_URL: "https://shots.test",
      GITHUB_STEP_SUMMARY: summary,
      GEMINI_RESERVE: "0",
      GEMINI_DAILY_QUOTA: JSON.stringify({ [PRIMARY_MODEL]: 2 }),
      MOCK_GEMINI: JSON.stringify([{ json: grade(null, "A", 4) }]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, out);
  // Quota 2: one request for the new site, so room for exactly one re-grade.
  const hist = (await db.execute("SELECT url, model, replaced_by_model FROM rubric_history")).rows;
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].model, hist[0].replaced_by_model], [BACKUP_MODEL, PRIMARY_MODEL]);
  const models = (await db.execute("SELECT json_extract(ai_rubric, '$.model') AS m FROM portfolios ORDER BY url")).rows.map((r) => r.m);
  assert.equal(models.filter((m) => m === PRIMARY_MODEL).length, 2);
  assert.equal(models.filter((m) => m === BACKUP_MODEL).length, 1);
  const logged = (await db.execute("SELECT COUNT(*) AS n FROM gemini_requests WHERE job = 'rubric' AND status = 200")).rows[0].n;
  assert.equal(logged, 2);
  const md = fs.readFileSync(summary, "utf8");
  assert.match(md, /### Gemini requests this run/);
  assert.match(md, /### Gemini today/);
  assert.match(md, /\*\*Warning:\*\*/); // 2 of 2 used
});
