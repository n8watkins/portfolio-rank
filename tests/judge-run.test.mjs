// pipeline/judge.mjs end to end, offline: the script runs as a child process
// on a throwaway database with fetch replaced (tests/helpers/mock-fetch.mjs),
// so Gemini and R2 are stand-ins and no request leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { judgeOutcome } from "../pipeline/judge-outcome.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import feed from "../data/feed.json" with { type: "json" };

const rubric = (over = {}) => {
  const axis = { score: 3, note: "fine" };
  return {
    is_portfolio: true,
    tier: "B",
    visual_design: axis,
    five_second_test: axis,
    storytelling: axis,
    writing: axis,
    memorability: axis,
    motion: axis,
    ...over,
  };
};

async function setup(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  const dbFile = path.join(dir, "db.sqlite");
  const db = createClient({ url: `file:${dbFile}` });
  await ensureRosterSchema(db);
  // The vote tables as the app creates them (lib/db.ts).
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER)`,
    "CREATE UNIQUE INDEX votes_rater_pair_idx ON votes (rater_id, pair_key)",
    `CREATE TABLE ratings (url TEXT PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1200,
       votes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ]);
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, health)
            VALUES (?, ?, 'live', ?, datetime('now'), ?, ?)`,
      args: [r.url, r.name ?? "Someone", r.key ?? `k${Math.random().toString(16).slice(2, 8)}`, r.rubric ? JSON.stringify(r.rubric) : null, r.health ?? null],
    });
  }
  return { dir, dbFile, db };
}

function runJudge(dir, dbFile, args, env = {}) {
  const summary = path.join(dir, `summary-${Math.random().toString(16).slice(2)}.md`);
  const log = path.join(dir, "gemini.log");
  const child = spawn(
    process.execPath,
    ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", ...args, "--rpm", "60000"],
    {
      env: {
        ...process.env,
        TURSO_DATABASE_URL: `file:${dbFile}`,
        TURSO_AUTH_TOKEN: "",
        GEMINI_API_KEY: "test-key-not-real",
        SHOTS_BASE_URL: "https://shots.test",
        GITHUB_STEP_SUMMARY: summary,
        MOCK_LOG: log,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) =>
    child.on("exit", (code) =>
      resolve({
        code,
        out,
        summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
        calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0,
      })
    )
  );
}

test("judgeOutcome: work with nothing done fails; mostly skipped fails; partial success passes", () => {
  assert.equal(judgeOutcome({ mode: "rubric", queued: 0 }).exitCode, 0);
  assert.equal(judgeOutcome({ mode: "rubric", queued: 5, ok: 0, errors: 5 }).exitCode, 1);
  assert.match(judgeOutcome({ mode: "rubric", queued: 4, skipped: 4 }).verdict, /nothing was judged: all 4 skipped/);
  assert.match(judgeOutcome({ mode: "rubric", queued: 10, ok: 3, skipped: 6 }).verdict, /most of the work was skipped \(6 of 10\)/);
  assert.equal(judgeOutcome({ mode: "rubric", queued: 10, ok: 5, skipped: 5 }).exitCode, 0);
  assert.equal(judgeOutcome({ mode: "rubric", queued: 300, ok: 40, errors: 5 }).exitCode, 0);
  // Abstentions are calls that answered.
  assert.equal(judgeOutcome({ mode: "pairwise", queued: 3, abstained: 3 }).exitCode, 0);
  assert.match(judgeOutcome({ mode: "pairwise", queued: 2, ok: 1, skipped: 1 }).summary, /\| 2 \| 1 \| 0 \| 0 \| 1 \|/);
});

test("rubric grades only listed sites that aren't down, and writes the counts to the job summary", async () => {
  const [a, b, c] = feed;
  const { dir, dbFile, db } = await setup([
    { url: a.url },
    { url: b.url },
    { url: c.url, health: "down" },
    { url: "https://left-the-list.example" },
  ]);
  const r = await runJudge(dir, dbFile, ["rubric"], { MOCK_GEMINI: JSON.stringify([{ json: rubric() }]) });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls, 2);
  const graded = (await db.execute("SELECT url FROM portfolios WHERE ai_rubric IS NOT NULL ORDER BY url")).rows.map((x) => x.url);
  assert.deepEqual(graded, [a.url, b.url].sort());
  const gone = (await db.execute("SELECT delisted_at FROM portfolios WHERE url = 'https://left-the-list.example'")).rows[0];
  assert.ok(gone.delisted_at, "the off-list row is marked delisted");
  assert.match(r.summary, /## AI judge: rubric/);
  assert.match(r.summary, /OK: 2 of 2 site\(s\) judged/);
});

test("rubric grades sites flagged needs_review first", async () => {
  const [a, b, c] = feed;
  const { dir, dbFile, db } = await setup([{ url: a.url }, { url: b.url }, { url: c.url }]);
  await db.execute({ sql: "UPDATE portfolios SET needs_review = 1 WHERE url = ?", args: [c.url] });
  const r = await runJudge(dir, dbFile, ["rubric", "--limit", "1"], { MOCK_GEMINI: JSON.stringify([{ json: rubric() }]) });
  assert.equal(r.code, 0, r.out);
  const graded = (await db.execute("SELECT url FROM portfolios WHERE ai_rubric IS NOT NULL")).rows.map((x) => x.url);
  assert.deepEqual(graded, [c.url]);
});

test("rubric fails when every row is skipped because screenshots are unavailable", async () => {
  const { dir, dbFile } = await setup([{ url: feed[0].url }, { url: feed[1].url }]);
  const r = await runJudge(dir, dbFile, ["rubric"], { MOCK_SHOTS: "error", MOCK_GEMINI: JSON.stringify([{ json: rubric() }]) });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.calls, 0);
  assert.match(r.out, /nothing was judged: all 2 skipped/);
  assert.match(r.summary, /\| 2 \| 0 \| 0 \| 0 \| 2 \|/);
});

test("pairwise leaves out sites graded not-a-portfolio, delisted or down", async () => {
  const [a, b, c, d, e] = feed;
  const { dir, dbFile, db } = await setup([
    { url: a.url, rubric: rubric({ tier: "A" }) },
    { url: b.url, rubric: rubric({ tier: "A" }) },
    { url: c.url, rubric: rubric({ tier: "S", is_portfolio: false }) },
    { url: d.url, rubric: rubric({ tier: "A" }), health: "down" },
    { url: "https://left-the-list.example", rubric: rubric({ tier: "S" }) },
    { url: e.url, rubric: rubric({ tier: "B" }) },
  ]);
  const r = await runJudge(dir, dbFile, ["pairwise", "--votes", "3"], {
    MOCK_GEMINI: JSON.stringify([{ json: { winner: "A", reason: "cleaner" } }]),
  });
  assert.equal(r.code, 0, r.out);
  const votes = (await db.execute("SELECT winner, loser FROM votes")).rows;
  assert.equal(votes.length, 3);
  const allowed = new Set([a.url, b.url, e.url]);
  for (const v of votes) {
    assert.ok(allowed.has(v.winner) && allowed.has(v.loser), `${v.winner} vs ${v.loser}`);
  }
  assert.match(r.summary, /## AI judge: pairwise/);
});

test("pairwise fails when no pair has screenshots", async () => {
  const { dir, dbFile } = await setup([
    { url: feed[0].url, rubric: rubric({ tier: "A" }) },
    { url: feed[1].url, rubric: rubric({ tier: "A" }) },
  ]);
  const r = await runJudge(dir, dbFile, ["pairwise", "--votes", "2"], { MOCK_SHOTS: "error" });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.calls, 0);
  assert.match(r.out, /nothing was judged/);
});
