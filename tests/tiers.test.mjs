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
  atLeast,
  distribution,
  familyOf,
  isPublicTier,
  modifierOf,
  tierLabel,
  orderLibrary,
  placeNew,
  rankKey,
  rankLibrary,
  rankScore,
  tierAt,
  tierOf,
  tierOfValue,
  tierValue,
  topPctAt,
} from "../lib/tiers.mjs";
import { LIBRARY_KEY, cachedLibrary, placeGrade, rankForWrite, refreshTiers } from "../lib/tiers-store.mjs";
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
  assert.deepEqual(TIERS, ["SSS", "S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"]);
  assert.deepEqual(
    TIER_LADDER.map((t) => t.count ?? t.top),
    [3, 10, 0.5, 1, 5.667, 10.333, 15, 33.333, 51.667, 70, 75, 80, 85, 100]
  );
  assert.deepEqual(PUBLIC_TIERS, ["SSS", "S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-"]);
  assert.equal(isPublicTier("B-"), true);
  assert.equal(isPublicTier("C+"), false);
  assert.equal(isPublicTier(null), false);
  assert.equal(tierValue("SSS"), 14);
  assert.equal(tierValue("D"), 1);
  assert.equal(tierOfValue(6), "B");
  // Families: SSS counts as S; the badge carries the plus or minus.
  assert.deepEqual(["SSS", "S+", "A-", "B", "D"].map(familyOf), ["S", "S", "A", "B", "D"]);
  assert.deepEqual(["SSS", "S+", "A-", "B"].map(modifierOf), ["", "+", "-", ""]);
  assert.equal(atLeast("A-", "A"), true);
  assert.equal(atLeast("B+", "A"), false);
  assert.equal(atLeast("SSS", "A"), true);
  assert.equal(tierLabel("A-"), "A\u2212");
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

/** A library of distinct keys, best first: n entries, urls s0 (best) to s<n-1>. */
const lib = (n, key = (i) => (n - i) * 10, elo = () => null) => orderLibrary(Array.from({ length: n }, (_, i) => ({ url: `https://s${String(i).padStart(5, "0")}.dev`, key: key(i), elo: elo(i) })));

test("a library of 3,000 distinct scores: exactly 3 SSS and 7 S+, then the owner's shares in thirds", () => {
  const order = lib(3000);
  // S to the 0.5% line (place 15), S- to 1% (30); A+ 1-5.667% (170), A to 10.333% (310), A- to 15% (450);
  // B+ to 33.333% (1,000), B to 51.667% (1,550), B- to 70% (2,100); C+ to 75%, C to 80%, C- to 85%; D the rest.
  assert.deepEqual(distribution(order), {
    SSS: 3, "S+": 7, S: 5, "S-": 15, "A+": 140, A: 140, "A-": 140, "B+": 550, B: 550, "B-": 550, "C+": 150, C: 150, "C-": 150, D: 450,
  });
  const ranks = rankLibrary(order);
  assert.equal(ranks.get(order[2].url).tier, "SSS");
  assert.equal(ranks.get(order[3].url).tier, "S+");
  assert.equal(ranks.get(order[9].url).tier, "S+");
  assert.equal(ranks.get(order[10].url).tier, "S");
  assert.equal(ranks.get(order[0].url).top, 1);
  assert.equal(topPctAt(1, 1000), 1);
  assert.equal(topPctAt(11, 1000), 2);
  assert.equal(tierAt(3000, 3000), "D");
});

test("count tiers break every tie: score, Gemini's letter, then ELO, then the address", () => {
  // 20 sites tied on score and letter at the top, then 980 distinct below.
  const order = lib(1000, (i) => (i < 20 ? 99990 : 50000 - i), (i) => (i < 20 ? 1200 + (i % 4) * 10 : null));
  const ranks = rankLibrary(order);
  const tier = (t) => order.filter((e) => ranks.get(e.url).tier === t);
  assert.equal(tier("SSS").length, 3);
  assert.equal(tier("S+").length, 7);
  // Highest ELO first (1230 on i = 3, 7, 11 ...), then the address.
  assert.deepEqual(tier("SSS").map((e) => e.url), ["https://s00003.dev", "https://s00007.dev", "https://s00011.dev"]);
  // The tied group's rest share a tier by the middle of their group (share tiers): all S or all A, never split.
  const rest = order.slice(10, 20).map((e) => ranks.get(e.url).tier);
  assert.equal(new Set(rest).size, 1);
  // A newcomer that ties exactly loses the tie to the library's members.
  const tied = placeNew(order, { url: "", key: 99990, elo: 1230 });
  assert.equal(tied.place, 6);
  assert.equal(tied.tier, "S+");
  assert.equal(placeNew(order, { url: "https://new.dev", key: 999999 }).tier, "SSS");
});

test("share tiers: equal scores share a place and a tier", () => {
  const order = lib(1000, (i) => (i < 100 ? 10000 - i : i < 200 ? 5000 : 4000 - i));
  const ranks = rankLibrary(order);
  // Places 101-200 tie: their middle, 150.5 of 1,000, is 15%: all A-, none split.
  assert.deepEqual([...new Set(order.slice(100, 200).map((e) => ranks.get(e.url).tier))], ["A-"]);
});

test("a small library hands out no tier it has no room for", () => {
  assert.equal(tierAt(1, 1), "B");
  // 3: the B family only (no band above or below has room).
  assert.ok(Object.entries(distribution(lib(3))).every(([t, n]) => !n || familyOf(t) === "B"));
  // 50: no count tiers (they need 100) and no S family (the top 1% holds no one): the best is A+.
  const fifty = rankLibrary(lib(50));
  assert.equal(fifty.get("https://s00000.dev").tier, "A+");
  assert.equal(fifty.get("https://s00049.dev").tier, "D");
  // 100: the count tiers start.
  assert.equal(rankLibrary(lib(100)).get("https://s00000.dev").tier, "SSS");
  assert.equal(placeNew([], { url: "x", key: 5 }).tier, "B");
});

test("tierOf reads only the rank, never Gemini's letter", () => {
  assert.equal(tierOf(grade(5, 100, "S")), null);
  assert.equal(tierOf(grade(5, 100, "S", { rank: { tier: "S+", score: 99, top: 1 } })), "S+");
  assert.equal(tierOf(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "S+" } })), null);
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
  assert.equal(placeGrade(grade(5, 100, "S", { is_portfolio: false }), orderLibrary(pool)), null);
});

test("the printable report shows public tiers only, and the note below them", () => {
  const ss = printView(JSON.stringify(grade(5, 100, "S", { rank: { tier: "A-", score: 99, top: 4 } })));
  assert.equal(ss.tier, "A-");
  assert.equal(ss.showTier, true);
  const c = printView(JSON.stringify(grade(2, 40, "A", { rank: { tier: "C+", score: 30, top: 72 } })));
  assert.equal(c.tier, "C+");
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
  for (let i = 0; i < 120; i++) rows.push([`https://site${i}.example/`, JSON.stringify(grade(1 + (i % 5), (i * 7) % 101, ["S", "A", "B", "C", "D"][i % 5]))]);
  rows.push(["https://notone.example/", JSON.stringify(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "SSS", score: 100, top: 1 } }))]);
  rows.push(["https://gone.example/", JSON.stringify(grade(5, 100, "S"))]);
  rows.push(["https://broken.example/", JSON.stringify({ error: "no_usable_captures" })]);
  for (const [url, rubric] of rows) await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, rubric] });
  await client.execute("UPDATE portfolios SET delisted_at = '2026-11-01' WHERE url = 'https://gone.example/'");
  await client.execute({
    sql: "INSERT INTO grade_jobs (id, url, site_key, status, result, report, created_at, updated_at) VALUES ('job1', 'https://x.example/', 'x.example', 'done', ?, ?, '2026-11-01', '2026-11-01')",
    args: [JSON.stringify(grade(5, 100, "S")), JSON.stringify({ percentile: { rank: 9, total: 10, topPct: 90, ahead: 10, level: 30 } })],
  });
  // Ranked on an older ladder: placed again.
  await client.execute({
    sql: "INSERT INTO grade_jobs (id, url, site_key, status, result, report, created_at, updated_at) VALUES ('job2', 'https://y.example/', 'y.example', 'done', ?, ?, '2026-11-01', '2026-11-01')",
    args: [JSON.stringify(grade(1, 0, "D")), JSON.stringify({ rank: { tier: "B", score: 0, top: 50, v: 1 } })],
  });

  const first = await refreshTiers(client, { now: Date.parse("2026-11-12T00:00:00Z") });
  assert.equal(first.library, 120);
  assert.equal(first.cleared, 1);
  assert.equal(first.jobs, 2);
  const sum = Object.values(first.distribution).reduce((a, b) => a + b, 0);
  assert.equal(sum, 120);
  assert.equal(first.distribution.SSS, 3);
  assert.equal(first.distribution["S+"], 7);
  const read = async (url) => JSON.parse(String((await client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0].ai_rubric));
  const best = await read("https://site119.example/");
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
  assert.equal(job.percentile.total, 121);
  assert.equal(job.percentile.level, 30);
  const job2 = JSON.parse(String((await client.execute("SELECT report FROM grade_jobs WHERE id = 'job2'")).rows[0].report));
  assert.equal(job2.rank.tier, "D");

  // Nothing changed: nothing written.
  const second = await refreshTiers(client, { now: Date.parse("2026-11-12T01:00:00Z") });
  assert.equal(second.updated, 0);
  assert.equal(second.cleared, 0);
  assert.equal(second.jobs, 0);

  // The cached library places a new grade at once.
  assert.equal((await cachedLibrary(client, { now: Date.parse("2026-11-12T01:30:00Z") })).length, 120);
  const fresh = await rankForWrite(client, grade(5, 100, "S"), { now: Date.parse("2026-11-12T01:30:00Z") });
  assert.equal(fresh.rank.tier, "SSS");
  const not = await rankForWrite(client, grade(5, 100, "S", { is_portfolio: false, rank: { tier: "S" } }));
  assert.equal(not.rank, undefined);
  const cached = (await client.execute({ sql: "SELECT v FROM cache WHERE k = ?", args: [LIBRARY_KEY] })).rows[0];
  assert.ok(cached);
});
