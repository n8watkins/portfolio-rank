// Tiers by rank (lib/tiers.mjs, lib/tiers-store.mjs), offline: the score,
// the ladder, ties, small libraries, and the refresh on a throwaway database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  CHECKS_WHEN_UNKNOWN,
  PUBLIC_TIERS,
  TIERS,
  TIER_LADDER,
  distribution,
  isPublicTier,
  placeKey,
  rankKey,
  rankScore,
  sortedKeys,
  tierAt,
  tierOf,
  tierOfValue,
  tierValue,
  topPctAt,
} from "../lib/tiers.mjs";
import { LIBRARY_KEY, cachedLibraryKeys, placeGrade, rankForWrite, refreshTiers } from "../lib/tiers-store.mjs";
import { compareWithPool, printView } from "../lib/grader/report.mjs";
import { celebrationLevel } from "../lib/grader/present.mjs";

/** A rubric v2 grade with every AI axis at `axis` (1-5), a checks score and Gemini's letter. */
const grade = (axis, checks = 80, letter = "B", extra = {}) => ({
  is_portfolio: true,
  tier: letter,
  visual_design: { score: axis, note: "" },
  five_second_test: { score: axis, note: "" },
  storytelling: { score: axis, note: "" },
  writing: { score: axis, note: "" },
  memorability: { score: axis, note: "" },
  quality_score: axis,
  checks_score: checks,
  rubric_version: 2,
  model: "gemini-3.5-flash-lite",
  judged_at: "2026-11-12T00:00:00.000Z",
  ...extra,
});

test("the ladder: owner's cut-offs in order, B public, C and D private", () => {
  assert.deepEqual(TIERS, ["SSS", "SS", "S", "A", "B", "C", "D"]);
  assert.deepEqual(
    TIER_LADDER.map((t) => t.top),
    [2, 5, 10, 20, 80, 95, 100]
  );
  assert.deepEqual(PUBLIC_TIERS, ["SSS", "SS", "S", "A", "B"]);
  assert.equal(isPublicTier("B"), true);
  assert.equal(isPublicTier("C"), false);
  assert.equal(isPublicTier(null), false);
  assert.equal(tierValue("SSS"), 7);
  assert.equal(tierValue("D"), 1);
  assert.equal(tierOfValue(3.4), "B");
  assert.equal(tierOfValue(4.4), "A");
});

test("the score: 80% the AI's weighted scores, 20% the code checks; unknown checks count the typical result", () => {
  assert.equal(rankScore(grade(5, 100)), 100);
  assert.equal(rankScore(grade(1, 0)), 0);
  assert.equal(rankScore(grade(3, 50)), 0.8 * 50 + 0.2 * 50);
  // A v1 grade: bare axis scores, no quality_score and no checks.
  const v1 = { tier: "A", is_portfolio: true, visual_design: 5, five_second_test: 5, storytelling: 5, writing: 5, memorability: 5 };
  assert.equal(rankScore(v1), 80 + 0.2 * CHECKS_WHEN_UNKNOWN);
  assert.equal(rankScore({ error: "no_usable_captures" }), null);
  assert.equal(rankScore(grade(5, 100, "S", { is_portfolio: false })), null);
  // Gemini's letter only breaks ties.
  assert.ok(rankKey(grade(4, 80, "S")) > rankKey(grade(4, 80, "A")));
  assert.ok(rankKey(grade(4, 81, "D")) > rankKey(grade(4, 80, "S")));
});

test("a library of 1,000 distinct scores gets the owner's shares exactly", () => {
  const keys = sortedKeys(Array.from({ length: 1000 }, (_, i) => i * 10));
  assert.deepEqual(distribution(keys), { SSS: 20, SS: 30, S: 50, A: 100, B: 600, C: 150, D: 50 });
  assert.equal(tierAt(1, 1000), "SSS");
  assert.equal(tierAt(1000, 1000), "D");
  assert.equal(topPctAt(1, 1000), 1);
  assert.equal(topPctAt(20, 1000), 2);
  assert.equal(topPctAt(21, 1000), 3);
});

test("ties share a place and a tier: the middle of the group decides", () => {
  // 100 sites: 10 tied at the top, then distinct scores.
  const keys = sortedKeys([...Array(10).fill(9999), ...Array.from({ length: 90 }, (_, i) => i)]);
  const top = placeKey(keys, 9999, { member: true });
  assert.equal(top.position, 5.5);
  // Middle of the group at 5%: the whole group is SS, none SSS, none S.
  assert.equal(top.tier, "SS");
  const dist = distribution(keys);
  assert.equal(dist.SSS, 0);
  assert.equal(dist.SS, 10);
});

test("a small library hands out no tier it has no room for", () => {
  assert.equal(tierAt(1, 1), "B");
  assert.deepEqual(distribution(sortedKeys([3, 2, 1])), { SSS: 0, SS: 0, S: 0, A: 0, B: 3, C: 0, D: 0 });
  // 10: the best is S (top 10% holds one site), never SS or SSS; the worst is C, D needs 20.
  const ten = sortedKeys(Array.from({ length: 10 }, (_, i) => i));
  assert.equal(placeKey(ten, 9, { member: true }).tier, "S");
  assert.equal(placeKey(ten, 0, { member: true }).tier, "C");
  // 50: SSS needs exactly this many.
  const fifty = sortedKeys(Array.from({ length: 50 }, (_, i) => i));
  assert.equal(placeKey(fifty, 49, { member: true }).tier, "SSS");
  assert.equal(placeKey(sortedKeys(fifty.slice(1)), 48, { member: true }).tier, "SS");
  // Empty: nothing to rank against.
  assert.equal(placeKey([], 5).tier, "B");
});

test("a newcomer is placed as if added; tierOf reads only the rank, never Gemini's letter", () => {
  const keys = sortedKeys(Array.from({ length: 99 }, (_, i) => i * 10));
  const p = placeKey(keys, 10000);
  assert.equal(p.total, 100);
  assert.equal(p.rank, 1);
  assert.equal(p.tier, "SSS");
  assert.equal(tierOf(grade(5, 100, "S")), null);
  assert.equal(tierOf(grade(5, 100, "S", { rank: { tier: "SS", score: 99, top: 3 } })), "SS");
  assert.equal(tierOf(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "SS" } })), null);
});

test("a visitor's grade is ranked against the pool, with 'graded against N' and a matching tier", () => {
  const pool = Array.from({ length: 200 }, (_, i) => ({ url: `https://s${i}.example/`, name: `s${i}`, mu: 25, key: rankKey(grade(1 + (i % 5), i % 100)), tier: null, axes: {}, roles: [] }));
  const best = compareWithPool(grade(5, 100, "S"), pool);
  assert.equal(best.rank.tier, "SSS");
  assert.equal(best.percentile.total, 201);
  assert.equal(best.percentile.topPct, 1);
  assert.equal(celebrationLevel({ tier: best.rank.tier, percentile: best.percentile }), 5);
  const low = compareWithPool(grade(1, 0, "D"), pool);
  assert.equal(low.rank.tier, "D");
  // Not a portfolio: no rank.
  assert.equal(placeGrade(grade(5, 100, "S", { is_portfolio: false }), sortedKeys(pool.map((p) => p.key))), null);
});

test("the printable report shows public tiers only, and the note below them", () => {
  const ss = printView(JSON.stringify(grade(5, 100, "S", { rank: { tier: "SS", score: 99, top: 4 } })));
  assert.equal(ss.tier, "SS");
  assert.equal(ss.showTier, true);
  const c = printView(JSON.stringify(grade(2, 40, "A", { rank: { tier: "C", score: 30, top: 90 } })));
  assert.equal(c.tier, "C");
  assert.equal(c.showTier, false);
  // Gemini's letter alone shows nothing.
  assert.equal(printView(JSON.stringify(grade(5, 100, "S"))).showTier, false);
});

async function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  return client;
}

test("refreshTiers writes each grade's rank, only when it changed, and ranks old reports", async () => {
  const client = await db();
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push([`https://site${i}.example/`, JSON.stringify(grade(1 + (i % 5), (i * 7) % 101, ["S", "A", "B", "C", "D"][i % 5]))]);
  rows.push(["https://notone.example/", JSON.stringify(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "SSS", score: 100, top: 1 } }))]);
  rows.push(["https://gone.example/", JSON.stringify(grade(5, 100, "S"))]);
  rows.push(["https://broken.example/", JSON.stringify({ error: "no_usable_captures" })]);
  for (const [url, rubric] of rows) await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, rubric] });
  await client.execute("UPDATE portfolios SET delisted_at = '2026-11-01' WHERE url = 'https://gone.example/'");
  await client.execute({
    sql: "INSERT INTO grade_jobs (id, url, site_key, status, result, report, created_at, updated_at) VALUES ('job1', 'https://x.example/', 'x.example', 'done', ?, ?, '2026-11-01', '2026-11-01')",
    args: [JSON.stringify(grade(5, 100, "S")), JSON.stringify({ percentile: { rank: 9, total: 10, topPct: 90, ahead: 10, level: 30 } })],
  });

  const first = await refreshTiers(client, { now: Date.parse("2026-11-12T00:00:00Z") });
  assert.equal(first.library, 60);
  assert.equal(first.cleared, 1);
  assert.equal(first.jobs, 1);
  const sum = Object.values(first.distribution).reduce((a, b) => a + b, 0);
  assert.equal(sum, 60);
  const read = async (url) => JSON.parse(String((await client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0].ai_rubric));
  const best = await read("https://site59.example/");
  assert.ok(TIERS.includes(best.rank.tier));
  // Gemini's own letter stays as it was.
  assert.equal(best.tier, "D");
  // Not a portfolio: its rank is removed.
  assert.equal((await read("https://notone.example/")).rank, undefined);
  // Delisted: placed against the library, not counted in it.
  assert.equal((await read("https://gone.example/")).rank.tier, "SSS");
  assert.equal((await read("https://broken.example/")).rank, undefined);
  const job = JSON.parse(String((await client.execute("SELECT report FROM grade_jobs WHERE id = 'job1'")).rows[0].report));
  assert.equal(job.rank.tier, "SSS");
  assert.equal(job.percentile.total, 61);
  assert.equal(job.percentile.level, 30);

  // Nothing changed: nothing written.
  const second = await refreshTiers(client, { now: Date.parse("2026-11-12T01:00:00Z") });
  assert.equal(second.updated, 0);
  assert.equal(second.cleared, 0);
  assert.equal(second.jobs, 0);

  // The cached library places a new grade at once.
  assert.equal((await cachedLibraryKeys(client, { now: Date.parse("2026-11-12T01:30:00Z") })).length, 60);
  const fresh = await rankForWrite(client, grade(5, 100, "S"), { now: Date.parse("2026-11-12T01:30:00Z") });
  assert.equal(fresh.rank.tier, "SSS");
  const not = await rankForWrite(client, grade(5, 100, "S", { is_portfolio: false, rank: { tier: "S" } }));
  assert.equal(not.rank, undefined);
  const cached = (await client.execute({ sql: "SELECT v FROM cache WHERE k = ?", args: [LIBRARY_KEY] })).rows[0];
  assert.ok(cached);
});
