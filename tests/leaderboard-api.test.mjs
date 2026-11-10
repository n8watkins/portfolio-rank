// End to end: GET /api/leaderboard (ranking v2, RANKING.md) on the running
// production build (`npm run test:e2e`), reading what the recompute wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { assignShownRanks, ensureRankingSchema } from "../lib/ranking/store.mjs";
import { migrate } from "../lib/schema.mjs";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

test("leaderboard API: rejects an unknown view, serves each view best first with ranks without gaps", async () => {
  const bad = await fetch(`${BASE}/api/leaderboard?view=elo`);
  assert.equal(bad.status, 400);

  await migrate(db);
  await ensureRankingSchema(db);
  const [a, b, c] = feed.slice(-3).map((p) => p.url);
  await db.execute("DELETE FROM site_ratings WHERE view = 'people'");
  await db.batch([
    // A URL that is not on the list is never shown, and the ranks close up.
    { sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, tier) VALUES ('people', ?, 1, 31, 3, 'confident', 0, 9, 7, 2, 'A')", args: [b] },
    { sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, tier) VALUES ('people', 'https://not-on-the-list.example', 2, 30, 3, 'confident', 0, 9, 5, 4, NULL)", args: [] },
    { sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, tier) VALUES ('people', ?, 3, 29.5, 6, 'unsure', 1, 2, 1, 1, NULL)", args: [a] },
    { sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence, tied_with_next, comparisons, wins, losses, tier) VALUES ('people', ?, 4, 20, 4, 'provisional', 0, 4, 0, 4, 'D')", args: [c] },
  ]);
  // The listed sites, as the roster sync writes them; the recompute numbers
  // the shown sites after writing a board.
  for (const url of [a, b, c]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live') ON CONFLICT(url) DO UPDATE SET status = 'live', health = NULL, delisted_at = NULL", args: [url] });
  }
  await assignShownRanks(db);
  const res = await fetch(`${BASE}/api/leaderboard?view=people&limit=2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.view, "people");
  assert.equal(body.total, 3);
  assert.deepEqual(body.rows.map((r) => [r.rank, r.url]), [[1, b], [2, a]]);
  assert.deepEqual([body.rows[0].low, body.rows[0].high, body.rows[0].confidence], [25, 37, "confident"]);
  assert.equal(body.rows[1].tiedWithNext, true);
  const page2 = await (await fetch(`${BASE}/api/leaderboard?view=people&limit=2&offset=2`)).json();
  assert.deepEqual(page2.rows.map((r) => [r.rank, r.url]), [[3, c]]);
  // Merged is the default view.
  assert.equal((await (await fetch(`${BASE}/api/leaderboard`)).json()).view, "merged");
});
