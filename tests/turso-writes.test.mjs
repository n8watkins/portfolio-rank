// The writes that would hit Turso Free's 10 million rows a month first
// (docs/COSTS.md section C, fix 4): the nightly recompute writes only the
// site_ratings and rank_history rows that changed, never deletes and
// re-inserts whole views, and still leaves exactly the board a full rewrite
// would.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import { simulate } from "../lib/ranking/simulate.mjs";
import { ensureRankingSchema, writeResults } from "../lib/ranking/store.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writes-"));
  return createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
}

const config = rankingConfig({});
const grade = JSON.stringify({ tier: "B", is_portfolio: true });

async function setup(urls) {
  const db = tempDb();
  await migrate(db);
  await ensureRankingSchema(db);
  await db.batch(urls.map((u) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [u, grade] })));
  return db;
}

const write = (db, input, opts = {}) => {
  const result = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts });
  return writeResults(db, { ...result, digest: "test", config, ...opts });
};

/** Every board row and every history row, as the app would read them. */
const snapshot = async (db) => ({
  ratings: (await db.execute("SELECT view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, seed_mu, seed_sigma, seed_basis, tier, shown_rank FROM site_ratings ORDER BY view, url")).rows.map((r) => ({ ...r })),
  history: (await db.execute("SELECT view, week, url, rank, mu, sigma FROM rank_history ORDER BY view, week, url")).rows.map((r) => ({ ...r })),
});

// A month of simulated comparisons over a small library, cut at a day.
const urls = Array.from({ length: 60 }, (_, i) => `https://site-${String(i).padStart(2, "0")}.example`);
const sim = simulate({ sites: urls.map((url) => ({ url })), days: 21, seed: "writes", aiPerDay: 20, batchedPerDay: 6, humansPerDay: 8 });
const upTo = (day) => {
  const cut = new Date(Date.parse("2026-09-14T12:00:00Z") + day * 86400000).toISOString();
  return { sites: sim.sites, comparisons: sim.comparisons.filter((c) => c.created_at < cut), resets: [] };
};

test("a recompute with nothing new writes no board or history row", async () => {
  const db = await setup(urls);
  const first = await write(db, upTo(20));
  const rows = first.ratings.written;
  assert.ok(rows >= 3 * urls.length, "every site on every view");
  assert.ok(first.history.written > 0);
  const before = await snapshot(db);
  const again = await write(db, upTo(20));
  assert.deepEqual(again.ratings, { written: 0, deleted: 0, unchanged: rows, shown: rows });
  assert.deepEqual(again.history, { written: 0, deleted: 0 });
  assert.deepEqual(await snapshot(db), before);
});

test("a night's new comparisons write only the rows that moved, and the board equals a full rewrite", async () => {
  const db = await setup(urls);
  const rows = (await write(db, upTo(19))).ratings.written;
  const night = await write(db, upTo(20));
  // Some rows moved, many did not.
  assert.ok(night.ratings.written > 0);
  assert.ok(night.ratings.unchanged > 0, `expected unchanged rows, got ${JSON.stringify(night.ratings)}`);
  assert.equal(night.ratings.written + night.ratings.unchanged, rows);

  // The same input written from scratch gives the same tables.
  const fresh = await setup(urls);
  await write(fresh, upTo(20), { full: true });
  const a = await snapshot(db);
  const b = await snapshot(fresh);
  assert.deepEqual(a.ratings, b.ratings);
  // History: the incremental run keeps the weeks before the last stored one as they were, so compare the recent weeks.
  const lastWeeks = (h) => {
    const weeks = [...new Set(h.map((r) => r.week))].sort().slice(-2);
    return h.filter((r) => weeks.includes(r.week));
  };
  assert.deepEqual(lastWeeks(a.history), lastWeeks(b.history));
});

test("a site that leaves the list is deleted from every view; shown ranks follow without a rewrite", async () => {
  const db = await setup(urls);
  await write(db, upTo(20));
  const gone = urls[5];
  const input = upTo(20);
  const out = await write(db, { ...input, sites: input.sites.filter((s) => s.url !== gone), comparisons: input.comparisons.filter((c) => !JSON.stringify(c.ranking ?? c.shown).includes(gone)) });
  assert.ok(out.ratings.deleted >= 3);
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM site_ratings WHERE url = ?", args: [gone] })).rows[0].n), 0);
  for (const view of ["merged", "people", "ai"]) {
    const ranks = (await db.execute({ sql: "SELECT shown_rank FROM site_ratings WHERE view = ? AND shown_rank IS NOT NULL ORDER BY shown_rank", args: [view] })).rows.map((r) => Number(r.shown_rank));
    assert.deepEqual(ranks, Array.from({ length: ranks.length }, (_, i) => i + 1), `${view}: shown ranks are 1..n with no gap`);
  }
});

test("the latest stored week is found by index, never by a scan of rank_history", async () => {
  const db = await setup(urls);
  await write(db, upTo(20));
  const plan = (await db.execute("EXPLAIN QUERY PLAN SELECT MAX(week) AS w FROM rank_history WHERE view = 'ai'")).rows.map((r) => String(r.detail)).join(" | ");
  assert.match(plan, /USING (COVERING )?INDEX/);
  assert.doesNotMatch(plan, /^SCAN rank_history$/);
});

test("a week's snapshot is written once, after the week ends", async () => {
  const db = await setup(urls);
  const input = upTo(20);
  const lastAt = input.comparisons.at(-1).created_at;
  // During the last week of comparisons: only the weeks before it are stored.
  const during = await write(db, input, { now: new Date(lastAt) });
  const weeks = async () => (await db.execute("SELECT DISTINCT week FROM rank_history ORDER BY week")).rows.map((r) => String(r.week));
  const { weekOf } = await import("../lib/ranking/views.mjs");
  const current = weekOf(lastAt);
  assert.ok(!(await weeks()).includes(current), "the running week is not stored");
  assert.ok(during.history.written > 0);
  // The night after the week ends: that week is written once, and a later night writes nothing.
  const after = new Date(Date.parse(`${current}T00:00:00Z`) + 8 * 86400000);
  const closed = await write(db, input, { now: after });
  assert.ok((await weeks()).includes(current));
  assert.ok(closed.history.written > 0);
  const later = await write(db, input, { now: new Date(after.getTime() + 86400000) });
  assert.deepEqual(later.history, { written: 0, deleted: 0 });
});
