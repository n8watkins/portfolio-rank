// Gemini monitoring (pipeline/gemini-log.mjs) and grade history
// (pipeline/rubric-history.mjs). Offline: Gemini is a stand-in, the
// database a throwaway file. (The 3.1-vs-3.5 grade pairs compared Gemini's
// letter and dropped axes; they were removed with rubric v3.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createRequestLog, dailyTotals, ensureGeminiLog, runSummary } from "../pipeline/gemini-log.mjs";
import { ensureRubricHistory, replaceGradeStatements } from "../pipeline/rubric-history.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
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
  portfolio_reason: "Shows projects the person built",
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
  await log.record({ at, model: PRIMARY_MODEL, status: 200, reason: "ok", retry: true, latencyMs: 1200, inputTokens: 1_000_000, outputTokens: 100_000, thoughtsTokens: 50_000 });
  await log.record({ at, model: BACKUP_MODEL, status: 429, reason: "HTTP 429 daily quota", fallback: true });
  const rows = (await db.execute("SELECT job, run_id, model, status, retry, fallback, input_tokens, thoughts_tokens FROM gemini_requests ORDER BY id")).rows;
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[1].job, rows[1].run_id, rows[1].retry, rows[1].input_tokens, rows[1].thoughts_tokens], ["rubric", "42", 1, 1000000, 50000]);
  const md = runSummary(log.rows, { [PRIMARY_MODEL]: { in: 0.1, out: 0.4 } });
  assert.match(md, new RegExp(`\\| ${PRIMARY_MODEL} \\| 2 \\| 1 \\| 0 \\| 1 \\| 0 \\| 0 \\| 1 \\| 0 \\| 1000000 \\| 100000 \\| 50000 \\| \\$0\\.1600 \\|`));
  assert.match(md, new RegExp(`\\| ${BACKUP_MODEL} \\| 1 \\| 0 \\| 0 \\| 0 \\| 1 \\| 0 \\| 0 \\| 1 \\|`));
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

async function judgeRun({ newSites = 1, oldGrades = 0, quota, budget, env = {} }) {
  const { dir, file, db } = tempDb();
  await ensureRosterSchema(db);
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT, loser TEXT, pair_key TEXT,
       rater_type TEXT, rater_id TEXT, created_at TEXT DEFAULT (datetime('now')), delta INTEGER)`,
    `CREATE TABLE ratings (url TEXT PRIMARY KEY, elo INTEGER, votes INTEGER, updated_at TEXT)`,
  ]);
  const sites = feed.slice(0, newSites + oldGrades);
  for (const [i, p] of sites.entries()) {
    const old = i >= newSites ? JSON.stringify(grade(BACKUP_MODEL, "B")) : null;
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric) VALUES (?, 'Someone', 'live', ?, datetime('now'), ?)",
      args: [p.url, `k${i}`, old],
    });
  }
  const summary = path.join(dir, "summary.md");
  const child = spawn(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", "rubric", "--rpm", "60000", "--no-browser"], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${file}`,
      TURSO_AUTH_TOKEN: "",
      GEMINI_API_KEY: "test-key-not-real",
      SHOTS_BASE_URL: "https://shots.test",
      GITHUB_STEP_SUMMARY: summary,
      // The accountant's cap for new grades (pipeline/budget.mjs), no reserve.
      GEMINI_BUDGET: JSON.stringify({ reserve: 0, stages: { grade_new: { cap: budget[PRIMARY_MODEL] } } }),
      GEMINI_DAILY_QUOTA: JSON.stringify(quota),
      MOCK_GEMINI: JSON.stringify([{ json: grade(null, "A", 4) }]),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  return { code, out, db, md: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "" };
}

test("judge.mjs grades new sites on 3.5, never re-grades older grades, and logs every request", async () => {
  // One new site and five old 3.1 grades: only the new site is graded (owner, 2026-11-21).
  const { code, out, db, md } = await judgeRun({
    newSites: 1,
    oldGrades: 5,
    quota: { [PRIMARY_MODEL]: 5 },
    budget: { [PRIMARY_MODEL]: 5, [BACKUP_MODEL]: 0 },
  });
  assert.equal(code, 0, out);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM rubric_history")).rows[0].n, 0);
  const models = (await db.execute("SELECT json_extract(ai_rubric, '$.model') AS m FROM portfolios")).rows.map((r) => r.m);
  assert.equal(models.filter((m) => m === PRIMARY_MODEL).length, 1);
  assert.equal(models.filter((m) => m === BACKUP_MODEL).length, 5);
  const logged = Object.fromEntries(
    (await db.execute("SELECT job, COUNT(*) AS n FROM gemini_requests WHERE status = 200 GROUP BY job")).rows.map((r) => [r.job, Number(r.n)])
  );
  assert.deepEqual(logged, { "grade-new": 1 }, "each request is logged under the budget's job name");
  assert.match(md, /### Gemini requests this run/);
  assert.match(md, /### Gemini today/);
  assert.match(md, /\| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
});

test("with today's 3.5 budget used up, grading waits for tomorrow instead of failing or using 3.1", async () => {
  // A 3.5 budget of 2 leaves no room for a grade (up to 4 requests); catch-up off.
  const { code, out, db, md } = await judgeRun({
    newSites: 2,
    quota: { [PRIMARY_MODEL]: 500 },
    budget: { [PRIMARY_MODEL]: 2, [BACKUP_MODEL]: 450 },
  });
  assert.equal(code, 0, out);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests")).rows[0].n, 0);
  assert.match(md, /today's budget is used; 2 waiting for tomorrow/);
});

test("the default daily quotas are 500 for 3.5 and 500 for 3.1", async () => {
  const { DEFAULT_DAILY_QUOTA } = await import("../pipeline/gemini-log.mjs");
  assert.deepEqual(DEFAULT_DAILY_QUOTA, { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 });
});

test("once 3.5's grading budget is used the rest waits for tomorrow: no catch-up on 3.1, even with the old GEMINI_CATCHUP=true", async () => {
  const { code, out, db, md } = await judgeRun({
    newSites: 3,
    quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
    budget: { [PRIMARY_MODEL]: 4, [BACKUP_MODEL]: 450 },
    env: { GEMINI_CATCHUP: "true" },
  });
  assert.equal(code, 0, out);
  const byModel = Object.fromEntries(
    (await db.execute("SELECT model, COUNT(*) AS n FROM gemini_requests GROUP BY model")).rows.map((r) => [r.model, r.n])
  );
  assert.deepEqual(byModel, { [PRIMARY_MODEL]: 1 });
  const models = (await db.execute("SELECT json_extract(ai_rubric, '$.model') AS m FROM portfolios WHERE ai_rubric IS NOT NULL")).rows.map((r) => r.m);
  assert.deepEqual(models, [PRIMARY_MODEL]);
  assert.match(md, /OK: 1 of 1 site\(s\) judged/);
  assert.match(md, /\| 1 \| 1 \| 0 \| 0 \| 0 \| 2 \|/);
  assert.match(md, /Stopped early: today's gemini-3\.5-flash-lite budget for new grades is used \(4 request\(s\) allowed this run\); 2 site\(s\) wait for tomorrow \(no fallback to a lower model: GEMINI_FALLBACK is off\)/);
});

test("nothing is written by 3.1, even when 3.5 is busy, and old 3.1 grades are left as they are", async () => {
  // 2 new sites and 1 old 3.1 grade; 3.5 answers once, then stays at 503.
  const { code, out, db, md } = await judgeRun({
    newSites: 2,
    oldGrades: 1,
    quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
    budget: { [PRIMARY_MODEL]: 400, [BACKUP_MODEL]: 450 },
    env: {
      MOCK_FAST_TIMERS: "1",
      MOCK_GEMINI: JSON.stringify([{ json: grade(null, "A", 4) }, { status: 503, raw: "{}" }]),
    },
  });
  assert.equal(code, 0, out); // graded what it could
  const requested = (await db.execute("SELECT DISTINCT model FROM gemini_requests")).rows.map((r) => r.model);
  assert.deepEqual(requested, [PRIMARY_MODEL]);
  const rows = (await db.execute("SELECT json_extract(ai_rubric, '$.model') AS m FROM portfolios WHERE ai_rubric IS NOT NULL")).rows.map((r) => r.m).sort();
  // One new site graded on 3.5; the other waits for the next run, and the 3.1 grade is untouched.
  assert.deepEqual(rows, [BACKUP_MODEL, PRIMARY_MODEL]);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM rubric_history")).rows[0].n, 0);
  assert.match(md, /Stopped early: gemini unavailable: gemini-3\.5-flash-lite HTTP 503 after 3 retries; the rest waits for the next run \(no fallback to a lower model/);
});
