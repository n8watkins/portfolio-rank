// Tiers kept incrementally (lib/tiers-db.mjs): a vote moves two rows, the
// histogram follows by trigger, the daily run finds the cutoffs with a few
// indexed reads and rewrites only the letters that changed, and every query
// it runs uses an index (no scan of the table).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { applyFaceoff, bucketOf, computeCutoffs, dailyTiers, ensureTierSchema, readSiteRow, readTierMeta, standingOf, undoFaceoff } from "../lib/tiers-db.mjs";
import { cautious, orderLibrary, rankLibrary, seedRating, tierForRating } from "../lib/tiers.mjs";

async function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-inc-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  await ensureTierSchema(client);
  return client;
}

const url = (i) => `https://m${String(i).padStart(5, "0")}.dev/`;

/** `n` members with starting ranks by place, plus a graded grade each, so the daily run can write the letter. */
async function library(client, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const s = seedRating(i + 1, n);
    const rating = cautious(s);
    rows.push({
      sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, member, seeded, points) VALUES (?, ?, ?, ?, ?, 1, 1, ?)",
      args: [url(i), s.mu, s.sigma, rating, bucketOf(rating), 100 - i / n],
    });
    rows.push({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url(i), JSON.stringify({ tier: "B", is_portfolio: true, rank: { tier: "B" } })] });
  }
  for (let k = 0; k < rows.length; k += 400) await client.batch(rows.slice(k, k + 400), "write");
}

const histMatches = async (client) => {
  const h = (await client.execute("SELECT bucket, n FROM tier_hist WHERE n != 0 ORDER BY bucket")).rows.map((r) => [Number(r.bucket), Number(r.n)]);
  const g = (await client.execute("SELECT bucket, COUNT(*) AS n FROM tier_ratings WHERE member = 1 GROUP BY bucket ORDER BY bucket")).rows.map((r) => [Number(r.bucket), Number(r.n)]);
  assert.deepEqual(h, g);
};

test("the histogram follows every insert, rating change, membership change and delete", async () => {
  const client = await db();
  await library(client, 300);
  await histMatches(client);
  await applyFaceoff(client, { winner: url(299), loser: url(0) });
  await histMatches(client);
  await client.execute({ sql: "UPDATE tier_ratings SET member = 0 WHERE url = ?", args: [url(5)] });
  await client.execute({ sql: "DELETE FROM tier_ratings WHERE url = ?", args: [url(6)] });
  await histMatches(client);
});

test("a vote moves its two portfolios at once and marks them; Undo takes it back exactly", async () => {
  const client = await db();
  await library(client, 50);
  const before = await readSiteRow(client, url(49));
  const after = await applyFaceoff(client, { winner: url(49), loser: url(0), voteId: 7 });
  assert.ok(after[url(49)].mu > before.mu);
  const row = await readSiteRow(client, url(49));
  assert.equal(row.votes, 1);
  assert.equal(row.faceoffs, 1);
  assert.equal(Number((await client.execute({ sql: "SELECT dirty FROM tier_ratings WHERE url = ?", args: [url(49)] })).rows[0].dirty), 1);
  // An AI comparison counts a quarter.
  await applyFaceoff(client, { winner: url(10), loser: url(11), rater: "ai" });
  assert.equal((await readSiteRow(client, url(10))).faceoffs, 0.25);
  // Undo, with nothing in between: exactly the rating before.
  assert.equal(await undoFaceoff(client, { voteId: 7, winner: url(49), loser: url(0) }), true);
  const back = await readSiteRow(client, url(49));
  assert.equal(back.mu, before.mu);
  assert.equal(back.sigma, before.sigma);
  assert.equal(back.votes, 0);
  assert.equal(await undoFaceoff(client, { voteId: 7, winner: url(49), loser: url(0) }), false);
  // A site with no row yet (not graded) gets one, outside the library.
  await applyFaceoff(client, { winner: "https://ungraded.dev/", loser: url(1) });
  const fresh = await readSiteRow(client, "https://ungraded.dev/");
  assert.equal(fresh.member, 0);
  assert.equal(fresh.votes, 1);
  await histMatches(client);
});

test("the cutoffs give every member the same tier as the full ranking", async () => {
  const client = await db();
  await library(client, 1500);
  // Some votes, so the ratings are not just the seeds.
  for (let k = 0; k < 60; k++) await applyFaceoff(client, { winner: url(1400 + k), loser: url(k * 7) });
  const { n, cutoffs } = await computeCutoffs(client);
  assert.equal(n, 1500);
  const rows = (await client.execute("SELECT url, mu, sigma FROM tier_ratings WHERE member = 1")).rows;
  const full = rankLibrary(orderLibrary(rows.map((r) => ({ url: String(r.url), mu: Number(r.mu), sigma: Number(r.sigma), seeded: true }))));
  let same = 0;
  for (const r of rows) if (tierForRating(cautious({ mu: Number(r.mu), sigma: Number(r.sigma) }), cutoffs) === full.get(String(r.url)).tier) same++;
  assert.equal(same, rows.length);
});

/** Counts the rows each statement returns plus the rows an OFFSET skips: what a row-billed database reads. */
function counting(client) {
  const stats = { reads: 0, writes: 0, statements: [] };
  const offsetOf = (stmt) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    if (!/OFFSET \?/i.test(sql)) return 0;
    const args = stmt.args ?? [];
    return Number(args[args.length - 1]) || 0;
  };
  const wrap = (stmt, res) => {
    stats.reads += res.rows.length + offsetOf(stmt);
    stats.writes += res.rowsAffected || 0;
    stats.statements.push(typeof stmt === "string" ? stmt : stmt.sql);
    return res;
  };
  return {
    stats,
    db: {
      execute: async (stmt) => wrap(stmt, await client.execute(stmt)),
      batch: async (stmts, mode) => {
        const out = await client.batch(stmts, mode);
        out.forEach((res, i) => wrap(stmts[i], res));
        return out;
      },
    },
  };
}

test("the daily run reads a few rows, rewrites only changed letters, and never scans the table", async () => {
  const client = await db();
  await library(client, 2000);
  // The first run: every member gets its letter.
  const first = await dailyTiers(client);
  assert.equal(first.n, 2000);
  assert.ok(first.changed > 1000, "the first run writes the letters that differ from the stored B");
  const meta = await readTierMeta(client);
  // A day of votes: 30 face-offs among the lowest-ranked.
  for (let k = 0; k < 30; k++) await applyFaceoff(client, { winner: url(1999 - k), loser: url(1500 + k) });
  const { db: counted, stats } = counting(client);
  // The schema is already there for this client; the counting wrapper is a new object, so mark it ready by running once.
  const second = await dailyTiers(counted, { purge: async (urls) => (counted.purged = urls) });
  assert.ok(second.candidates < 200, `looked at ${second.candidates}`);
  assert.ok(stats.reads < 1000, `read ${stats.reads} rows`);
  // Every letter now matches the cutoffs; the profiles that changed were purged.
  const after = await readTierMeta(client);
  const rows = (await client.execute("SELECT url, mu, sigma, faceoffs, votes, member, seeded, points, tier FROM tier_ratings WHERE member = 1")).rows;
  for (const r of rows) {
    const s = standingOf({ mu: Number(r.mu), sigma: Number(r.sigma), faceoffs: Number(r.faceoffs), votes: Number(r.votes), member: 1, seeded: 1, points: null }, after);
    assert.equal(String(r.tier), s.tier, String(r.url));
  }
  assert.equal((counted.purged ?? []).length, second.changed);
  // The stored grade follows the changed letters.
  const g = JSON.parse(String((await client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url(1999)] })).rows[0].ai_rubric));
  assert.equal(g.rank.tier, rows.find((r) => String(r.url) === url(1999)).tier);
  // Nothing new: nothing changes, and little is read.
  const third = await dailyTiers(client);
  assert.equal(third.changed, 0);
  assert.equal(third.voted, 0);
  assert.ok(meta.at);
  // No statement of the daily run scans tier_ratings.
  for (const sql of new Set(stats.statements.filter((q) => /tier_ratings/.test(q) && /^\s*SELECT/i.test(q)))) {
    const args = (sql.match(/\?/g) ?? []).map(() => 0);
    const plan = (await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args })).rows.map((r) => String(r.detail)).join(" | ");
    assert.doesNotMatch(plan, /SCAN tier_ratings(?! USING)/, `${sql} -> ${plan}`);
  }
});
