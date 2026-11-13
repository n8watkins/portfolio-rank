// The reads that would hit Turso Free's monthly limit first (docs/COSTS.md
// section C): /top's vote counts come from counters kept by triggers, not a
// scan of votes, and the board is read one indexed page at a time, with the
// visible ranks stored by the recompute.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { assignShownRanks, ensureRankingSchema } from "../lib/ranking/store.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reads-"));
  return createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
}

const counters = async (db) => ({
  total: Number((await db.execute("SELECT n FROM vote_totals WHERE k = 'all'")).rows[0]?.n ?? -1),
  stars: Object.fromEntries((await db.execute("SELECT url, n FROM star_counts WHERE n > 0 ORDER BY url")).rows.map((r) => [r.url, Number(r.n)])),
});
const truth = async (db) => ({
  total: Number((await db.execute("SELECT COUNT(*) AS n FROM votes")).rows[0].n),
  stars: Object.fromEntries((await db.execute("SELECT winner AS url, COUNT(*) AS n FROM votes WHERE starred = 1 GROUP BY winner ORDER BY winner")).rows.map((r) => [r.url, Number(r.n)])),
});
const vote = (db, winner, loser, rater, starred = 0) =>
  db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES (?, ?, ?, 'human', ?, ?)", args: [winner, loser, `${winner}|${loser}`, rater, starred] });

test("vote counters: the first migration fills them from the votes already there, once", async () => {
  const db = tempDb();
  // A database from before the counters (schema version 1): votes exist.
  await db.batch([
    `CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL, pair_key TEXT,
       rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
       starred INTEGER NOT NULL DEFAULT 0)`,
  ]);
  await vote(db, "a", "b", "r1", 1);
  await vote(db, "a", "c", "r2", 1);
  await vote(db, "b", "c", "r3", 0);
  await migrate(db);
  assert.deepEqual(await counters(db), { total: 3, stars: { a: 2 } });
  // Running the migration again (every deploy) never fills them twice.
  await migrate(db);
  assert.deepEqual(await counters(db), { total: 3, stars: { a: 2 } });
});

test("vote counters follow every insert, delete, star change and winner change", async () => {
  const db = tempDb();
  await migrate(db);
  assert.deepEqual(await counters(db), { total: 0, stars: {} });
  await vote(db, "a", "b", "r1", 1);
  await vote(db, "c", "b", "r2", 1);
  await vote(db, "b", "c", "r3");
  assert.deepEqual(await counters(db), await truth(db));
  // Undo deletes a vote.
  await db.execute("DELETE FROM votes WHERE rater_id = 'r2'");
  assert.deepEqual(await counters(db), await truth(db));
  // A star added and taken away, and a winner changed.
  await db.execute("UPDATE votes SET starred = 1 WHERE rater_id = 'r3'");
  assert.deepEqual(await counters(db), await truth(db));
  await db.execute("UPDATE votes SET winner = 'z' WHERE rater_id = 'r1'");
  assert.deepEqual(await counters(db), await truth(db));
  await db.execute("UPDATE votes SET starred = 0 WHERE rater_id = 'r1'");
  // A claim (rater_type anon -> human) changes nothing counted.
  await db.execute("UPDATE votes SET rater_type = 'anon' WHERE rater_id = 'r3'");
  assert.deepEqual(await counters(db), await truth(db));
  assert.deepEqual(await counters(db), { total: 2, stars: { b: 1 } });
});

test("reading the counters scans a few rows, not the vote log", async () => {
  const db = tempDb();
  await migrate(db);
  for (let i = 0; i < 300; i++) await vote(db, `s${i % 7}`, `t${i}`, `r${i}`, i % 3 === 0 ? 1 : 0);
  const plan = async (sql) => (await db.execute(`EXPLAIN QUERY PLAN ${sql}`)).rows.map((r) => String(r.detail)).join(" | ");
  assert.match(await plan("SELECT n FROM vote_totals WHERE k = 'all'"), /USING INDEX|PRIMARY KEY/);
  assert.match(await plan("SELECT url, n FROM star_counts WHERE n > 0 ORDER BY n DESC, url LIMIT 10"), /star_counts/);
  assert.doesNotMatch(await plan("SELECT url, n FROM star_counts WHERE n > 0 ORDER BY n DESC, url LIMIT 10"), /votes/);
  assert.deepEqual(await counters(db), await truth(db));
});

test("board: shown ranks skip hidden, delisted and ungraded sites, and a page is one indexed range read", async () => {
  const db = tempDb();
  await migrate(db);
  await db.execute("ALTER TABLE portfolios ADD COLUMN delisted_at TEXT").catch(() => {});
  await ensureRankingSchema(db);
  const sites = ["a", "down", "b", "gone", "c", "failed", "d", "ungraded", "notone"];
  const graded = JSON.stringify({ tier: "B", is_portfolio: true });
  await db.batch([
    ...sites.map((u) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [u, graded] })),
    // Only graded portfolios are shown (owner rule): no grade, or "not a portfolio", stays off every board.
    "UPDATE portfolios SET ai_rubric = NULL WHERE url = 'ungraded'",
    `UPDATE portfolios SET ai_rubric = '{"tier":"C","is_portfolio":false}' WHERE url = 'notone'`,
    "UPDATE portfolios SET health = 'down' WHERE url = 'down'",
    "UPDATE portfolios SET delisted_at = '2026-11-01' WHERE url = 'gone'",
    "UPDATE portfolios SET status = 'dead' WHERE url = 'failed'",
  ]);
  for (const view of ["merged", "people"]) {
    const order = view === "merged" ? sites : [...sites].reverse();
    await db.batch(
      order.map((u, i) => ({
        sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES (?, ?, ?, 25, 3, 'unsure')",
        args: [view, u, i + 1],
      }))
    );
  }
  const out = await assignShownRanks(db);
  assert.equal(out.shown, 8);
  const shown = async (view) => (await db.execute({ sql: "SELECT url, shown_rank FROM site_ratings WHERE view = ? AND shown_rank IS NOT NULL ORDER BY shown_rank", args: [view] })).rows.map((r) => [r.url, Number(r.shown_rank)]);
  assert.deepEqual(await shown("merged"), [["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  assert.deepEqual(await shown("people"), [["d", 1], ["c", 2], ["b", 3], ["a", 4]]);
  // A second run with nothing changed writes nothing.
  assert.equal((await assignShownRanks(db)).updated, 0);
  // A site the health check clears is shown after the next run.
  await db.execute("UPDATE portfolios SET health = 'live' WHERE url = 'failed'");
  await assignShownRanks(db);
  assert.deepEqual(await shown("merged"), [["a", 1], ["b", 2], ["c", 3], ["failed", 4], ["d", 5]]);
  const plan = (await db.execute("EXPLAIN QUERY PLAN SELECT url FROM site_ratings WHERE view = 'merged' AND shown_rank > 2 ORDER BY shown_rank LIMIT 2")).rows.map((r) => String(r.detail)).join(" | ");
  assert.match(plan, /site_ratings_shown_idx/);
});
