// Tiers by ELO (lib/tiers.mjs, lib/tiers-rating.mjs, lib/tiers-store.mjs),
// offline: the ladder, the replay of face-offs, the starting tier, the
// cautious order, small libraries, the report card's standing
// (lib/grade-score.mjs), Play's draw, and the refresh on a throwaway database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  AI_VOTE_WEIGHT,
  ELO_START,
  MIN_FACEOFFS,
  PUBLIC_TIERS,
  STARTING_TIER,
  TIERS,
  TIER_LADDER,
  atLeast,
  distribution,
  entryOf,
  eloOf,
  familyOf,
  isPublicTier,
  isRanked,
  modifierOf,
  orderLibrary,
  placeNew,
  rankLibrary,
  tierAt,
  tierLabel,
  tierOf,
  tierOfValue,
  tierValue,
} from "../lib/tiers.mjs";
import { rateFaceoffs } from "../lib/tiers-rating.mjs";
import { CHECKS_WHEN_UNKNOWN, gradeKey, gradeScore, standing } from "../lib/grade-score.mjs";
import { LIBRARY_KEY, cachedLibrary, cachedLibraryState, placeGrade, rankForWrite, refreshTiers } from "../lib/tiers-store.mjs";
import { compareWithPool, printView } from "../lib/grader/report.mjs";
import { drawCandidates } from "../lib/play/draw.mjs";
import { CHECK_POINTS, checkPoints, checkShares, libraryMedians, pointFixes, unpackCheck } from "../lib/check-points.mjs";
import { compareSeed, seedRating } from "../lib/tiers.mjs";

test("points from automated checks: 100 in all, measured from saved data, the median where nothing was measured", () => {
  const max = Object.values(CHECK_POINTS).filter((v) => v > 0).reduce((a, b) => a + b, 0);
  assert.equal(max, 100);
  assert.equal(CHECK_POINTS.template, -15);
  const full = checkShares({
    psi: { ok: true, scores: { performance: 100, accessibility: 100, seo: 100, "best-practices": 100 } },
    psiDesktop: { ok: true, scores: { performance: 100 } },
    inspect: { ok: true, https: true, customDomain: true, ogTitle: "x", ogDescription: "y", ogImageLoads: true, githubUrl: "g", hasResume: true, hasContact: true, copyrightYear: 2026 },
    grade: { checks: { original: true }, facts: { project_links: { checked: 4, ok: 4, broken: 0 } } },
    meta: { overflow390: false, consoleErrors: 0 },
    year: 2026,
  });
  const medians = libraryMedians([full]);
  const all = checkPoints(full, medians);
  assert.equal(all.total, 100);
  assert.ok(all.items.every((i) => i.measured));
  assert.deepEqual(pointFixes(all), []);
  // A known template costs 15; two working links of the minimum three earn two thirds of the project points.
  const template = checkShares({ grade: { facts: { template: "Some theme", project_links: { checked: 2, ok: 2 } } } });
  const t = checkPoints(template, medians);
  assert.equal(t.items.find((i) => i.id === "template").points, -15);
  assert.equal(t.items.find((i) => i.id === "projects").points, 10);
  // Nothing measured: never a zero, the library median, marked.
  const none = checkPoints(checkShares({}), libraryMedians([full, checkShares({ psi: { ok: true, scores: { performance: 0 } } })]));
  const perf = none.items.find((i) => i.id === "perfMobile");
  assert.equal(perf.measured, false);
  assert.equal(perf.points, 7.5);
  // Nobody measured it: the same neutral value for everyone (half, no template penalty).
  assert.equal(libraryMedians([checkShares({})]).phone, 0.5);
  assert.equal(libraryMedians([checkShares({})]).template, 0);
  // The fix list names the gain: "+5 if you add a share image".
  const noImage = checkPoints({ ...full, shareImage: 0 }, medians);
  assert.deepEqual(pointFixes(noImage), [{ id: "shareImage", gain: 5, text: "+5 if you add a share image" }]);
  // Stored as [item, points, measured] rows and read back the same.
  const rows = noImage.items.map((i) => [i.id, i.points, i.measured ? 1 : 0]);
  assert.equal(unpackCheck(rows).total, noImage.total);
  assert.deepEqual(pointFixes(unpackCheck(rows)), pointFixes(noImage));
});

test("starting ranks: by points (then the Gemini score), evenly from the best to the last, held loosely", () => {
  assert.deepEqual(seedRating(1, 101), { mu: 33, sigma: 25 / 3 });
  assert.deepEqual(seedRating(101, 101), { mu: 17, sigma: 25 / 3 });
  assert.equal(seedRating(51, 101).mu, 25);
  const a = { url: "a", points: 80, key: 10, first: 1 };
  const b = { url: "b", points: 80, key: 20, first: 2 };
  const c = { url: "c", points: 90, key: 0, first: 3 };
  assert.deepEqual([a, b, c].sort(compareSeed).map((x) => x.url), ["c", "b", "a"]);
  // A seeded portfolio is ranked at once, with no votes at all.
  const order = orderLibrary(Array.from({ length: 200 }, (_, i) => ({ url: `s${i}`, ...seedRating(i + 1, 200), seeded: true })));
  const ranks = rankLibrary(order);
  assert.equal(ranks.get("s0").tier, "SSS");
  assert.equal(ranks.get("s199").tier, "D");
  assert.equal(ranks.get("s0").votes, 0);
  assert.ok(ranks.get("s0").elo > ELO_START && ranks.get("s199").elo < ELO_START);
  // Real votes move a seed: the last one beating the best a few times climbs.
  const seeds = new Map([["low", seedRating(200, 200)], ["high", seedRating(1, 200)]]);
  const after = rateFaceoffs([faceoff("low", "high"), faceoff("low", "high"), faceoff("low", "high")], { seeds });
  assert.ok(after.get("low").mu > seeds.get("low").mu + 3);
  assert.equal(after.get("low").wins, 3);
});

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

let clock = Date.parse("2026-11-01T00:00:00Z");
/** One face-off as a comparison: `winner` beat `loser`. */
const faceoff = (winner, loser, extra = {}) => ({
  id: 0,
  created_at: new Date((clock += 1000)).toISOString(),
  rater_type: "human",
  method: "one_on_one",
  ranking: [[winner], [loser]],
  outcome: "ranked",
  starred: 0,
  experiment: null,
  ...extra,
});

test("the ladder: owner's cut-offs in order (A is the top 30%), B public, C and D private", () => {
  assert.deepEqual(TIERS, ["SSS", "S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"]);
  assert.deepEqual(
    TIER_LADDER.map((t) => t.count ?? t.top),
    [3, 1, 1, 1, 10.667, 20.333, 30, 43.333, 56.667, 70, 75, 80, 85, 100]
  );
  assert.deepEqual(PUBLIC_TIERS, ["SSS", "S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-"]);
  assert.equal(isPublicTier("B-"), true);
  assert.equal(isPublicTier("C+"), false);
  assert.equal(isPublicTier(null), false);
  assert.equal(tierValue("SSS"), 14);
  assert.equal(tierValue("D"), 1);
  assert.equal(tierOfValue(6), "B");
  assert.deepEqual(["SSS", "S+", "A-", "B", "D"].map(familyOf), ["S", "S", "A", "B", "D"]);
  assert.deepEqual(["SSS", "S+", "A-", "B"].map(modifierOf), ["", "+", "-", ""]);
  assert.equal(atLeast("A-", "A"), true);
  assert.equal(atLeast("B+", "A"), false);
  assert.equal(tierLabel("A-"), "A−");
  assert.equal(STARTING_TIER, "B");
  assert.equal(MIN_FACEOFFS, 10);
  assert.equal(AI_VOTE_WEIGHT, 0.25);
});

test("the replay: a person's vote counts one face-off, an AI comparison a quarter; practice, skips and experiments never count", () => {
  const r = rateFaceoffs([
    faceoff("a", "b"),
    faceoff("a", "b", { rater_type: "ai" }),
    faceoff("a", "b", { rater_type: "anon" }),
    faceoff("a", "b", { outcome: "skip" }),
    faceoff("a", "b", { experiment: "backup-model" }),
    faceoff("a", "b", { method: "batched", rater_type: "ai" }),
    faceoff("a", "b", { ranking: "not json" }),
  ]);
  assert.equal(r.get("a").faceoffs, 1.25);
  assert.equal(r.get("b").faceoffs, 1.25);
  assert.equal(r.get("a").wins, 2);
  assert.equal(r.get("b").losses, 2);
  assert.ok(r.get("a").mu > 25 && r.get("b").mu < 25);
  // An AI comparison moves a rating less than a person's vote.
  const human = rateFaceoffs([faceoff("x", "y")]).get("x");
  const ai = rateFaceoffs([faceoff("x", "y", { rater_type: "ai" })]).get("x");
  assert.ok(ai.mu - 25 < human.mu - 25);
  assert.ok(ai.mu > 25);
  // The weight is a setting: 0 leaves the AI out.
  assert.equal(rateFaceoffs([faceoff("x", "y", { rater_type: "ai" })], { aiWeight: 0 }).size, 0);
  // Replayed in time order, whatever order they come in.
  const votes = [faceoff("p", "q"), faceoff("q", "p"), faceoff("q", "r")];
  assert.deepEqual(rateFaceoffs(votes).get("q"), rateFaceoffs([...votes].reverse()).get("q"));
});

test("without a starting rank, a portfolio starts at ELO 1200 and stays B until 10 face-offs, however lucky", () => {
  assert.equal(eloOf({ mu: 25, sigma: 25 / 3 }), ELO_START);
  assert.equal(entryOf({ url: "x" }).elo, ELO_START);
  // Nine straight wins: still B, with no place.
  const votes = Array.from({ length: 9 }, (_, i) => faceoff("lucky", `o${i}`));
  const r = rateFaceoffs(votes).get("lucky");
  const lucky = entryOf({ url: "lucky", ...r });
  assert.ok(lucky.elo > ELO_START);
  assert.equal(isRanked(lucky), false);
  const order = orderLibrary([lucky, ...Array.from({ length: 200 }, (_, i) => ({ url: `s${i}`, mu: 25, sigma: 6, faceoffs: 12 }))]);
  const placed = rankLibrary(order).get("lucky");
  assert.equal(placed.tier, "B");
  assert.equal(placed.provisional, true);
  assert.equal(placed.top, null);
  // The tenth face-off: its place sets the tier.
  const ten = entryOf({ url: "lucky", ...rateFaceoffs([...votes, faceoff("lucky", "o9")]).get("lucky") });
  assert.equal(isRanked(ten), true);
  assert.notEqual(placeNew(order, ten).tier, "B");
  // AI face-offs count a quarter: 39 of them are not yet 10, 40 are.
  assert.equal(isRanked(entryOf({ url: "z", faceoffs: 39 * 0.25 })), false);
  assert.equal(isRanked(entryOf({ url: "z", faceoffs: 40 * 0.25 })), true);
});

test("the order is cautious: a short perfect record doesn't jump past a long strong one", () => {
  // 10-0 against fresh opponents, and 40-10.
  const short = rateFaceoffs(Array.from({ length: 10 }, (_, i) => faceoff("short", `a${i}`))).get("short");
  const longVotes = Array.from({ length: 50 }, (_, i) => (i % 5 === 4 ? faceoff(`b${i}`, "long") : faceoff("long", `b${i}`)));
  const long = rateFaceoffs(longVotes).get("long");
  assert.ok(short.mu > long.mu, "the short record looks better on the mean alone");
  const order = orderLibrary([entryOf({ url: "short", ...short }), entryOf({ url: "long", ...long })]);
  assert.equal(order[0].url, "long");
  assert.ok(order[0].elo > order[1].elo, "the ELO shown follows the order");
});

/** A library of `n` ranked portfolios with distinct ratings, best first: urls s00000 (best) on. */
const lib = (n, faceoffs = 12) => orderLibrary(Array.from({ length: n }, (_, i) => ({ url: `https://s${String(i).padStart(5, "0")}.dev`, mu: 40 - i * 0.01, sigma: 6, faceoffs })));

test("bands by place among the ranked: SSS the top 3, S+/S/S- the rest of the top 1%, A to 30%, D the bottom 15%", () => {
  const order = lib(1000);
  const ranks = rankLibrary(order);
  const at = (i) => ranks.get(`https://s${String(i).padStart(5, "0")}.dev`).tier;
  assert.deepEqual([0, 1, 2].map(at), ["SSS", "SSS", "SSS"]);
  assert.deepEqual([3, 5, 6, 7, 8, 9].map(at), ["S+", "S+", "S", "S", "S-", "S-"]);
  assert.equal(at(10), "A+");
  assert.equal(at(299), "A-");
  assert.equal(at(300), "B+");
  assert.equal(at(699), "B-");
  assert.equal(at(700), "C+");
  assert.equal(at(849), "C-");
  assert.equal(at(850), "D");
  const dist = distribution(order);
  assert.equal(dist.A + dist["A+"] + dist["A-"], 290);
  assert.equal(dist.D, 150);
  assert.equal(ranks.get("https://s00000.dev").top, 1);
  // Provisional members are B and don't take a place among the ranked.
  const mixed = orderLibrary([...order, ...Array.from({ length: 500 }, (_, i) => ({ url: `https://new${i}.dev`, faceoffs: i % 10 }))]);
  const d2 = distribution(mixed);
  assert.equal(d2.B, dist.B + 500);
  assert.equal(rankLibrary(mixed).get("https://s00000.dev").tier, "SSS");
});

test("small libraries hand out only the tiers they have room for", () => {
  assert.deepEqual(Object.entries(distribution(lib(3))).filter(([, n]) => n), [["B+", 1], ["B", 1], ["B-", 1]]);
  const twenty = distribution(lib(20));
  assert.equal(twenty.SSS + twenty["S+"] + twenty.S + twenty["S-"], 0, "the S band needs 100 ranked");
  assert.equal(twenty["A+"], 2);
  assert.equal(twenty.D, 3);
  assert.equal(rankLibrary(lib(100)).get("https://s00000.dev").tier, "SSS");
  assert.equal(tierAt(1, 1), "B");
  // Equal ratings share a place and a tier.
  const tied = orderLibrary(Array.from({ length: 10 }, (_, i) => ({ url: `t${i}`, mu: 30, sigma: 6, faceoffs: 10 })));
  assert.deepEqual(new Set([...rankLibrary(tied).values()].map((p) => p.tier)), new Set(["B"]));
});

test("the report card: the grade's score and its standing, apart from the tier", () => {
  assert.equal(gradeScore(grade(5, 100)), 100);
  assert.equal(gradeScore(grade(1, 0)), 0);
  const v1 = { tier: "A", is_portfolio: true, visual_design: 5, five_second_test: 5, storytelling: 5, writing: 5, memorability: 5 };
  assert.equal(gradeScore(v1), 80 + 0.2 * CHECKS_WHEN_UNKNOWN);
  assert.equal(gradeScore(grade(5, 100, "S", { is_portfolio: false })), null);
  assert.ok(gradeKey(grade(4, 80, "S")) > gradeKey(grade(4, 80, "A")));
  assert.deepEqual(standing([10, 20, 30], 25), { rank: 2, total: 4, topPct: 38, ahead: 50 });
  assert.equal(standing([10], null), null);
});

test("tierOf reads the stored rank, never Gemini's letter", () => {
  assert.equal(tierOf(grade(5, 100, "S")), null);
  assert.equal(tierOf(grade(5, 100, "S", { rank: { tier: "A-", elo: 1400 } })), "A-");
  assert.equal(tierOf(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "S+" } })), null);
});

test("a visitor's report without a library: a starting rank from its own points (a listed site keeps its own ELO), and the grade's top N% by score", () => {
  const pool = Array.from({ length: 200 }, (_, i) => ({ url: `https://s${i}.example/`, name: `s${i}`, mu: 25, key: gradeKey(grade(1 + (i % 5), i % 100)), tier: null, axes: {}, roles: [] }));
  const best = compareWithPool(grade(5, 100, "S"), pool);
  assert.equal(best.rank.tier, "B");
  assert.equal(best.rank.provisional, false);
  assert.equal(best.rank.seeded, true);
  assert.ok(best.rank.points > 0);
  assert.equal(best.percentile.total, 201);
  assert.equal(best.percentile.topPct, 1);
  // A listed site with enough face-offs keeps the tier its ELO earns.
  const order = lib(200);
  const library = { order, others: [] };
  const listed = compareWithPool(grade(2, 40, "D"), pool, { library, url: "https://s00000.dev" });
  assert.equal(listed.rank.tier, "SSS");
  assert.equal(listed.rank.provisional, false);
  assert.equal(placeGrade(grade(5, 100, "S", { is_portfolio: false }), library), null);
});

test("the printable report shows public tiers only, and the note below them", () => {
  const ss = printView(JSON.stringify(grade(5, 100, "S", { rank: { tier: "A-", elo: 1500, top: 25 } })));
  assert.equal(ss.tier, "A-");
  assert.equal(ss.showTier, true);
  const c = printView(JSON.stringify(grade(2, 40, "A", { rank: { tier: "C+", elo: 1000, top: 72 } })));
  assert.equal(c.showTier, false);
  assert.equal(printView(JSON.stringify(grade(5, 100, "S"))).showTier, false);
});

test("Play draws mostly from portfolios that still need face-offs", () => {
  const pool = Array.from({ length: 100 }, (_, i) => ({ url: `u${i}` }));
  const settled = new Set(pool.slice(0, 90).map((p) => p.url));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  let needy = 0;
  let total = 0;
  for (let k = 0; k < 200; k++) {
    const c = drawCandidates(pool, settled, { random });
    assert.equal(new Set(c.map((p) => p.url)).size, 8);
    needy += c.filter((p) => !settled.has(p.url)).length;
    total += c.length;
  }
  // 10% of the pool, but most of the candidates.
  assert.ok(needy / total > 0.6, `${needy}/${total}`);
  // Nobody needs face-offs: the whole pool.
  assert.equal(drawCandidates(pool, new Set(pool.map((p) => p.url)), { random }).length, 8);
  assert.equal(drawCandidates(pool.slice(0, 3), new Set(), { random }).length, 3);
});

async function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiers-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  return client;
}

test("refreshTiers replays the votes, writes each grade's rank only when it changed, and places old reports", async () => {
  const client = await db();
  const url = (i) => `https://site${i}.example/`;
  await client.batch(
    Array.from({ length: 120 }, (_, i) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url(i), JSON.stringify(grade(1 + (i % 5), 80, "B"))] })),
    "write"
  );
  await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES ('https://notone.example/', 'live', ?)", args: [JSON.stringify(grade(5, 100, "S", { is_portfolio: false, rank: { tier: "SSS" } }))] });
  await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES ('https://broken.example/', 'live', ?)", args: [JSON.stringify({ error: "no_usable_captures" })] });
  // Sites 0-29 play 12 face-offs each (each against its 6 neighbours on either side, round the circle) in
  // people's votes: the lower number wins, so site 0 goes 12-0.
  const votes = [];
  for (let i = 0; i < 30; i++) for (let k = 1; k <= 6; k++) {
    const j = (i + k) % 30;
    votes.push([url(Math.min(i, j)), url(Math.max(i, j)), "human", `r${i}-${k}`]);
  }
  // Site 40 wins 20 AI comparisons: 5 face-offs, still B.
  for (let k = 0; k < 20; k++) votes.push([url(40), url(50 + (k % 10)), "ai", "judge"]);
  // Practice votes never count.
  for (let k = 0; k < 12; k++) votes.push([url(60), url(61), "anon", `anon:${k}`]);
  await client.batch(
    votes.map(([w, l, type, rater], i) => ({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('2026-11-01', ?))",
      args: [w, l, `${w}\n${l}\n${i}`, type, rater, `+${i} seconds`],
    })),
    "write"
  );
  await client.execute({
    sql: "INSERT INTO grade_jobs (id, url, site_key, status, result, report, created_at, updated_at) VALUES ('job1', 'https://x.example/', 'x.example', 'done', ?, ?, '2026-11-01', '2026-11-01')",
    args: [JSON.stringify(grade(5, 100, "S")), JSON.stringify({ rank: { tier: "SSS", score: 100, top: 1, v: 4 }, percentile: { rank: 1, total: 10, topPct: 5, ahead: 90, level: 30 } })],
  });

  // Saved check data for two sites: site 5 passes everything, site 6 is slow, has no share card and no links.
  const cache = (k, v) => ({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, 0)", args: [k, JSON.stringify(v)] });
  const psi = (p) => ({ ok: true, scores: { performance: p, accessibility: p, "best-practices": p, seo: p } });
  const inspect = (good) => ({
    ok: true,
    https: true,
    customDomain: good,
    title: good ? "Site" : null,
    description: good ? "About" : null,
    ogImageLoads: good,
    githubUrl: good ? "https://github.com/x" : null,
    hasGithubLink: good,
    hasResume: good,
    hasContact: good,
    linkedinUrl: null,
    copyrightYear: good ? 2026 : 2019,
  });
  await client.batch([cache(`psi:${url(5)}`, psi(100)), cache(`psi-desktop:${url(5)}`, psi(100)), cache(`inspect:${url(5)}`, inspect(true))], "write");
  await client.batch([cache(`psi:${url(6)}`, psi(20)), cache(`psi-desktop:${url(6)}`, psi(20)), cache(`inspect:${url(6)}`, inspect(false))], "write");

  const first = await refreshTiers(client, { now: Date.parse("2026-11-12T00:00:00Z") });
  assert.equal(first.library, 120);
  assert.equal(first.ranked, 120, "every graded portfolio has a starting rank from automated checks");
  assert.equal(first.cleared, 1);
  assert.equal(first.jobs, 1);
  assert.equal(Object.values(first.distribution).reduce((a, b) => a + b, 0), 120);
  assert.equal(first.distribution.SSS, 1, "120 ranked: the top 1% is one place");
  assert.ok(first.distribution.D >= 15, "letters appear at once, the bottom 15% too");
  const read = async (u) => JSON.parse(String((await client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [u] })).rows[0].ai_rubric));
  // Points: measured items for site 5 and 6, the library median for everything nobody measured.
  const best = await read(url(5));
  const poor = await read(url(6));
  assert.equal(best.rank.seeded, true);
  assert.ok(best.rank.points > poor.rank.points, `${best.rank.points} > ${poor.rank.points}`);
  assert.equal(best.rank.check.length, 14);
  assert.deepEqual(best.rank.check.find((r) => r[0] === "perfMobile"), ["perfMobile", 15, 1]);
  assert.deepEqual(poor.rank.check.find((r) => r[0] === "shareImage"), ["shareImage", 0, 1]);
  // Not measured for site 7: the median of the two measured (15 and 3), marked.
  assert.deepEqual((await read(url(7))).rank.check.find((r) => r[0] === "perfMobile"), ["perfMobile", 9, 0]);
  assert.ok(best.rank.elo > poor.rank.elo);
  // Real votes refine it; none are invented.
  const top = await read(url(0));
  assert.equal(top.rank.faceoffs, 12);
  assert.equal(top.rank.votes, 12);
  assert.equal(top.rank.provisional, false);
  assert.ok(top.rank.elo > ELO_START);
  // Gemini's own letter stays as it was.
  assert.equal(top.tier, "B");
  const ai = await read(url(40));
  assert.equal(ai.rank.faceoffs, 5);
  assert.equal(ai.rank.votes, 20);
  assert.equal((await read(url(60))).rank.votes, 0, "practice votes never count");
  assert.equal((await read("https://notone.example/")).rank, undefined);
  assert.equal((await read("https://broken.example/")).rank, undefined);
  // A visitor's report: a starting rank from the points its grade can show; the grade's own standing stays.
  const job = JSON.parse(String((await client.execute("SELECT report FROM grade_jobs WHERE id = 'job1'")).rows[0].report));
  assert.equal(job.rank.seeded, true);
  assert.equal(job.rank.provisional, false);
  assert.equal(job.percentile.topPct, 5);

  // Nothing changed: nothing written.
  const second = await refreshTiers(client, { now: Date.parse("2026-11-12T01:00:00Z") });
  assert.equal(second.updated, 0);
  assert.equal(second.cleared, 0);
  assert.equal(second.jobs, 0);

  // The cached library places a new grade at once: its points among the members', or a member's own rank.
  const now = Date.parse("2026-11-12T01:30:00Z");
  assert.equal((await cachedLibrary(client, { now })).length, 120);
  const fresh = await rankForWrite(client, grade(5, 100, "S"), { url: "https://brand-new.example/", now });
  assert.equal(fresh.rank.seeded, true);
  assert.equal(fresh.rank.check.length, 14);
  const regraded = await rankForWrite(client, grade(1, 0, "D"), { url: url(0), now });
  assert.equal(regraded.rank.tier, top.rank.tier, "a new grade doesn't change a member's tier until the refresh");
  const not = await rankForWrite(client, grade(5, 100, "S", { is_portfolio: false, rank: { tier: "S" } }));
  assert.equal(not.rank, undefined);
  const state = await cachedLibraryState(client, { now });
  assert.ok(state.medians && typeof state.medians.perfMobile === "number");
  assert.ok((await client.execute({ sql: "SELECT v FROM cache WHERE k = ?", args: [LIBRARY_KEY] })).rows[0]);
});
