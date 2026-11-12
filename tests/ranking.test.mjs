// The rating engine (lib/ranking), offline: no network, no Gemini, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENT_SIGMA,
  MU,
  SEED_SIGMA,
  SEED_SIGMA_OLD_GRADE,
  SIGMA_UNSURE,
  TIER_MU,
  rankingConfig,
} from "../lib/ranking/config.mjs";
import { buildBoard, confidenceOf, rateRanking, seedFromGrade, validRanking, winProbability } from "../lib/ranking/engine.mjs";
import { EXPERIMENT_VIEW, recompute, toIso, weekOf } from "../lib/ranking/views.mjs";
import { drawWeight, pairKey, planBatches, planPairs, slotKind } from "../lib/ranking/matchmaking.mjs";
import { cycleRate, positionBias, rankMovement, repeatDisagreement, wilson } from "../lib/ranking/analytics.mjs";
import { createRng, weightedIndex } from "../lib/ranking/prng.mjs";
import { medalFor, shownPlaces } from "../lib/ranking/places.mjs";
import { buildBatchRequest, buildPairRequest, parseBatchAnswer, parsePairAnswer } from "../pipeline/compare-prompts.mjs";

const v2 = (tier, quality_score = null) => ({ tier, quality_score, rubric_version: 2, model: "gemini-3.5-flash-lite", is_portfolio: true });
let nextId = 1;
const cmp = (winner, loser, over = {}) => ({
  id: nextId++,
  created_at: over.created_at ?? "2026-11-10T13:00:00.000Z",
  rater_type: "ai",
  model: "gemini-3.5-flash-lite",
  prompt_version: "compare-v1",
  method: "one_on_one",
  shown: [winner, loser],
  ranking: [[winner], [loser]],
  outcome: "ranked",
  starred: 0,
  experiment: null,
  ...over,
});

test("seeds: the tier sets the mean, the quality score nudges it within the tier, the grade's age sets sigma", () => {
  for (const [tier, mu] of Object.entries(TIER_MU)) assert.equal(seedFromGrade(v2(tier)).mu, mu);
  assert.equal(seedFromGrade(v2("S")).sigma, SEED_SIGMA);
  // A v1 grade or one by the backup model is trusted a little less.
  assert.equal(seedFromGrade({ ...v2("S"), rubric_version: 1 }).sigma, SEED_SIGMA_OLD_GRADE);
  assert.equal(seedFromGrade({ ...v2("S"), model: "gemini-3.1-flash-lite" }).sigma, SEED_SIGMA_OLD_GRADE);
  // Above the tier's usual quality nudges up, below nudges down, never more than 1.5.
  assert.ok(seedFromGrade(v2("B", 4)).mu > TIER_MU.B);
  assert.ok(seedFromGrade(v2("B", 3)).mu < TIER_MU.B);
  assert.equal(seedFromGrade(v2("B", 5)).mu, TIER_MU.B + 1.5);
  assert.equal(seedFromGrade(v2("D", 1)).mu, TIER_MU.D - 1.1);
  // The best A never reaches the worst S: tiers never overlap.
  assert.ok(seedFromGrade(v2("A", 5)).mu < seedFromGrade(v2("S", 1)).mu);
  // A v1 grade's axes give the quality when quality_score is missing.
  assert.equal(seedFromGrade({ tier: "A", visual_design: { score: 5 }, five_second_test: { score: 5 } }).quality, 5);
  // No grade, a bad tier or an error sentinel: neutral and unsure.
  for (const g of [null, {}, { tier: "Z" }, { error: "x" }]) assert.deepEqual([seedFromGrade(g).mu, seedFromGrade(g).sigma], [MU, SIGMA_UNSURE]);
});

test("rateRanking: the winner rises, weights scale the move, ties stay level, bad rankings are refused", () => {
  const start = { mu: 25, sigma: 6 };
  const get = () => start;
  const full = new Map(rateRanking(get, [["a"], ["b"]], 1));
  assert.ok(full.get("a").mu > 25 && full.get("b").mu < 25);
  assert.ok(full.get("a").sigma < 6);
  const half = new Map(rateRanking(get, [["a"], ["b"]], 0.5));
  assert.ok(Math.abs(half.get("a").mu - 25 - (full.get("a").mu - 25) / 2) < 1e-9, "half weight moves half as far");
  assert.ok(half.get("a").sigma > full.get("a").sigma, "and shrinks sigma less");
  const twice = new Map(rateRanking(get, [["a"], ["b"]], 2));
  assert.ok(twice.get("a").mu > full.get("a").mu);
  const tie = new Map(rateRanking(get, [["a", "b"]], 1));
  assert.equal(tie.get("a").mu, 25);
  assert.equal(tie.get("b").mu, 25);
  // A ranked group of five: the order holds.
  const group = new Map(rateRanking(get, [["a"], ["b"], ["c"], ["d"], ["e"]], 1));
  const mus = ["a", "b", "c", "d", "e"].map((u) => group.get(u).mu);
  assert.deepEqual([...mus].sort((x, y) => y - x), mus);
  for (const bad of [null, [], [["a"]], [["a"], ["a"]], [["a"], []], "x"]) {
    assert.equal(validRanking(bad), false);
    assert.equal(rateRanking(get, bad, 1), null);
  }
  assert.equal(rateRanking(get, [["a"], ["b"]], 0), null);
});

test("an upset moves an unsure site more than a settled one", () => {
  const ratings = { u: { mu: 25, sigma: 8 }, s: { mu: 25, sigma: 2 } };
  const unsure = new Map(rateRanking((x) => (x === "u" ? ratings.u : { mu: 25, sigma: 4 }), [["u"], ["o"]], 1));
  const settled = new Map(rateRanking((x) => (x === "s" ? ratings.s : { mu: 25, sigma: 4 }), [["s"], ["o"]], 1));
  assert.ok(unsure.get("u").mu - 25 > 4 * (settled.get("s").mu - 25));
});

test("board: sorted by mean with a stable order, ties flagged, confidence from sigma", () => {
  const board = buildBoard([
    ["b", { mu: 30, sigma: 1 }],
    ["a", { mu: 30, sigma: 1 }],
    ["c", { mu: 30, sigma: 0.5 }],
    ["d", { mu: 10, sigma: 1 }],
  ]);
  assert.deepEqual(board.map((r) => r.url), ["c", "a", "b", "d"]);
  assert.deepEqual(board.map((r) => r.rank), [1, 2, 3, 4]);
  assert.equal(board[0].tiedWithNext, true);
  assert.equal(board[2].tiedWithNext, false, "30 vs 10 is no tie");
  assert.equal(board[3].tiedWithNext, false);
  assert.ok(winProbability({ mu: 30, sigma: 1 }, { mu: 10, sigma: 1 }) > 0.95);
  assert.equal(confidenceOf(2), "settled");
  assert.equal(confidenceOf(CONFIDENT_SIGMA), "confident");
  assert.equal(confidenceOf(4.5), "provisional");
  assert.equal(confidenceOf(8), "unsure");
});

test("recompute: seeding by tier puts every S above every D before any comparison", () => {
  const sites = [];
  for (const tier of ["D", "S", "C", "A", "B"]) for (let i = 0; i < 5; i++) sites.push({ url: `https://${tier}${i}.dev`, grade: v2(tier, 1 + i) });
  const { boards } = recompute({ sites, comparisons: [], aiWeight: 0.5 });
  for (const view of ["merged", "ai"]) {
    const tiers = boards[view].map((r) => r.tier);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => "SABCD".indexOf(a) - "SABCD".indexOf(b)), view);
  }
  // People ignore the grades: everyone level.
  assert.ok(boards.people.every((r) => r.mu === MU && Math.abs(r.sigma - SIGMA_UNSURE) < 1e-3));
});

test("recompute: each view counts its own evidence, AI weighs less in Merged, experiments and skips never count", () => {
  const sites = ["a", "b", "c"].map((u) => ({ url: u, grade: v2("B") }));
  const human = cmp("a", "b", { rater_type: "human", model: null, prompt_version: null });
  const ai = cmp("c", "a");
  const skip = cmp("b", "c", { ranking: null, outcome: "skip" });
  const exp = cmp("b", "c", { experiment: "text-only" });
  const { boards, counted } = recompute({ sites, comparisons: [human, ai, skip, exp], aiWeight: 0.5 });
  const by = (view) => new Map(boards[view].map((r) => [r.url, r]));
  assert.deepEqual(counted, { merged: 2, people: 1, ai: 1 });
  assert.equal(by("people").get("c").mu, MU, "the AI comparison is not in People");
  assert.equal(by("ai").get("b").mu, 25, "the human vote is not in AI");
  const aiOnly = recompute({ sites, comparisons: [ai], aiWeight: 0.5 }).boards;
  const cMerged = aiOnly.merged.find((r) => r.url === "c").mu - 25;
  const cAi = aiOnly.ai.find((r) => r.url === "c").mu - 25;
  assert.ok(Math.abs(cMerged - cAi / 2) < 1e-3, "AI at half weight in Merged");
  // A starred human vote counts double.
  const star = recompute({ sites, comparisons: [{ ...human, starred: 1 }], aiWeight: 0.5 }).boards.people.find((r) => r.url === "a").mu;
  assert.ok(star > by("people").get("a").mu);
});

test("recompute: batched results are experiment only until the flag counts them", () => {
  const sites = ["a", "b", "c", "d", "e"].map((u) => ({ url: u, grade: v2("B") }));
  const batch = cmp("a", "b", { method: "batched", shown: ["e", "d", "c", "b", "a"], ranking: [["a"], ["b"], ["c"], ["d"], ["e"]] });
  const off = recompute({ sites, comparisons: [batch], aiWeight: 0.5 });
  assert.equal(off.counted.ai, 0);
  assert.equal(off.counted.merged, 0);
  assert.equal(off.counted[EXPERIMENT_VIEW], 1);
  assert.ok(off.boards[EXPERIMENT_VIEW][0].url === "a");
  const on = recompute({ sites, comparisons: [batch], aiWeight: 0.5, batchedCounts: true });
  assert.equal(on.counted.ai, 1);
  assert.equal(on.counted.merged, 1);
  assert.equal(on.boards[EXPERIMENT_VIEW], undefined);
  assert.equal(on.boards.ai[0].url, "a");
});

test("recompute: deterministic, replayed by time whatever the input order; a page change resets sigma", () => {
  const sites = ["a", "b", "c"].map((u) => ({ url: u, grade: v2("A") }));
  const list = [
    cmp("a", "b", { created_at: "2026-11-02 10:00:00" }),
    cmp("b", "c", { created_at: "2026-11-03T10:00:00Z" }),
    cmp("c", "a", { created_at: "2026-11-10T10:00:00Z" }),
  ];
  const one = recompute({ sites, comparisons: list, aiWeight: 0.5 });
  const two = recompute({ sites, comparisons: [...list].reverse(), aiWeight: 0.5 });
  assert.deepEqual(one, two);
  assert.deepEqual([...new Set(one.history.map((h) => h.week))], ["2026-11-02", "2026-11-09"]);
  const reset = recompute({ sites, comparisons: list, resets: [{ url: "a", at: "2026-11-05T00:00:00Z" }], aiWeight: 0.5 });
  const a = reset.boards.ai.find((r) => r.url === "a");
  assert.ok(a.sigma > 7, "sigma is back to unsure (then one comparison)");
  assert.equal(toIso("2026-11-02 10:00:00"), "2026-11-02T10:00:00.000Z");
  assert.equal(weekOf("2026-11-09T00:00:00Z"), "2026-11-09");
  assert.equal(weekOf("2026-11-15T23:59:59Z"), "2026-11-09");
});

test("recompute: unlisted sites are rated but not shown", () => {
  const sites = [
    { url: "a", grade: v2("B"), listed: true },
    { url: "gone", grade: v2("S"), listed: false },
  ];
  const { boards } = recompute({ sites, comparisons: [cmp("gone", "a"), cmp("a", "unknown")], aiWeight: 0.5 });
  assert.deepEqual(boards.ai.map((r) => r.url), ["a"]);
  assert.equal(boards.ai[0].comparisons, 2);
});

const pool = (n, sigma = () => 4) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://s${String(i).padStart(3, "0")}.dev`, mu: 15 + (20 * i) / n, sigma: sigma(i) }));

test("matchmaking: the same seed gives the same plan; 1 in 5 random; no duplicate pairs; per-site cap", () => {
  const sites = pool(300);
  const a = planPairs({ sites, n: 100, seed: "2026-11-10" });
  assert.deepEqual(a, planPairs({ sites, n: 100, seed: "2026-11-10" }));
  assert.notDeepEqual(a, planPairs({ sites, n: 100, seed: "2026-11-11" }));
  assert.equal(a.length, 100);
  assert.equal(a.filter((p) => p.kind === "random").length, 20);
  assert.equal(new Set(a.map((p) => pairKey(...p.shown))).size, 100);
  const uses = new Map();
  for (const p of a) for (const u of p.shown) uses.set(u, (uses.get(u) ?? 0) + 1);
  assert.ok(Math.max(...uses.values()) <= 3);
  // Close matches really are close: much closer than random ones on average.
  const mu = new Map(sites.map((s) => [s.url, s.mu]));
  const gap = (kind) => {
    const ps = a.filter((p) => p.kind === kind);
    return ps.reduce((s, p) => s + Math.abs(mu.get(p.shown[0]) - mu.get(p.shown[1])), 0) / ps.length;
  };
  assert.ok(gap("close") * 3 < gap("random"), `close ${gap("close")} random ${gap("random")}`);
  assert.equal(slotKind(4), "random");
  assert.equal(slotKind(19, { canRepeat: true }), "repeat");
  assert.equal(slotKind(19), "random");
});

test("matchmaking: the shown order is random; unsure sites are drawn more, settled ones less; cooldown pairs avoided", () => {
  const sites = pool(200, (i) => (i < 20 ? 8 : i < 100 ? 4 : 2));
  const counts = { unsure: 0, seeded: 0, settled: 0 };
  let lowerFirst = 0;
  let total = 0;
  for (let d = 0; d < 20; d++) {
    for (const p of planPairs({ sites, n: 50, seed: `day${d}` })) {
      total++;
      if (p.shown[0] < p.shown[1]) lowerFirst++;
      for (const u of p.shown) {
        const i = Number(u.match(/s(\d+)/)[1]);
        counts[i < 20 ? "unsure" : i < 100 ? "seeded" : "settled"]++;
      }
    }
  }
  assert.ok(lowerFirst / total > 0.4 && lowerFirst / total < 0.6, `order ${lowerFirst / total}`);
  // Per site: the 20 unsure sites appear far more often than the 100 settled ones.
  assert.ok(counts.unsure / 20 > 2 * (counts.seeded / 80), JSON.stringify(counts));
  assert.ok(counts.seeded / 80 > counts.settled / 100, JSON.stringify(counts));
  assert.ok(drawWeight({ sigma: 8 }) > drawWeight({ sigma: 4 }) && drawWeight({ sigma: 4 }) > drawWeight({ sigma: 2 }));
  // A pair in the cooldown set is never drawn as a close or random match.
  const two = pool(2);
  assert.deepEqual(planPairs({ sites: two, n: 1, seed: "x", recent: new Set([pairKey(two[0].url, two[1].url)]) }), []);
});

test("matchmaking: repeats re-ask an earlier pair in the other order", () => {
  const sites = pool(100);
  const past = [{ shown: [sites[3].url, sites[50].url] }];
  const plan = planPairs({ sites, n: 40, seed: "r", past });
  const repeats = plan.filter((p) => p.kind === "repeat");
  // Slots 19 and 39 are repeat slots; the one earlier pair can only be planned once a day.
  assert.equal(repeats.length, 1);
  for (const r of repeats) assert.deepEqual(r.shown, [sites[50].url, sites[3].url]);
});

test("matchmaking: batches have the right size, distinct sites, shuffled order, deterministic", () => {
  const sites = pool(200);
  const plan = planBatches({ sites, n: 30, size: 5, seed: "b" });
  assert.deepEqual(plan, planBatches({ sites, n: 30, size: 5, seed: "b" }));
  assert.equal(plan.length, 30);
  for (const g of plan) assert.equal(new Set(g.shown).size, 5);
  assert.equal(plan.filter((g) => g.kind === "random").length, 6);
  const sortedShown = plan.filter((g) => g.shown.join() === [...g.shown].sort().join()).length;
  assert.ok(sortedShown < 5, "the order shown is shuffled");
  assert.deepEqual(planBatches({ sites: pool(3), n: 1, size: 5, seed: "b" }), []);
});

test("prng: seeded, uniform-ish, weighted picks follow weights", () => {
  const r1 = createRng("s");
  const r2 = createRng("s");
  for (let i = 0; i < 5; i++) assert.equal(r1(), r2());
  const rng = createRng("w");
  const hits = [0, 0, 0];
  for (let i = 0; i < 9000; i++) hits[weightedIndex(rng, [1, 2, 6])]++;
  assert.ok(hits[2] > hits[1] && hits[1] > hits[0]);
  assert.equal(weightedIndex(rng, [0, 0]), -1);
});

test("analytics: position bias, repeat disagreement, contradictions and rank movement", () => {
  const list = [
    cmp("a", "b", { shown: ["a", "b"] }),
    cmp("a", "b", { shown: ["b", "a"] }),
    cmp("b", "a", { shown: ["b", "a"], created_at: "2026-11-11T00:00:00Z" }),
    cmp("b", "c", { shown: ["b", "c"] }),
    cmp("c", "a", { shown: ["c", "a"] }),
    cmp("c", "a", { shown: ["c", "a"], created_at: "2026-11-12T00:00:00Z" }),
    cmp("x", "y", { shown: null }),
  ];
  const [bias] = positionBias(list);
  assert.equal(bias.n, 6);
  assert.equal(bias.firstWins, 5);
  const [rep] = repeatDisagreement(list);
  assert.deepEqual([rep.pairs, rep.repeats, rep.disagreements], [2, 3, 1]);
  // a-b is split 2-1 for a, b beats c, c beats a twice: a cycle a>b>c>a.
  const [cyc] = cycleRate(list);
  assert.deepEqual([cyc.triangles, cyc.cyclic, cyc.rate], [1, 1, 1]);
  const [lo, hi] = wilson(50, 100);
  assert.ok(lo < 0.5 && hi > 0.5);
  const history = [
    { view: "ai", week: "2026-11-02", url: "a", rank: 1 },
    { view: "ai", week: "2026-11-02", url: "b", rank: 2 },
    { view: "ai", week: "2026-11-02", url: "c", rank: 3 },
    { view: "ai", week: "2026-11-09", url: "c", rank: 1 },
    { view: "ai", week: "2026-11-09", url: "a", rank: 2 },
    { view: "ai", week: "2026-11-09", url: "b", rank: 3 },
  ];
  const m = rankMovement(history, "ai");
  assert.deepEqual(m.weeks, [{ week: "2026-11-09", sites: 3, moved: 3, mean: 1.333, median: 1, p90: 2 }]);
  assert.deepEqual(m.climbers.map((c) => [c.url, c.change]), [["c", 2]]);
  assert.deepEqual(m.fallers.map((c) => c.url), ["a", "b"]);
});

test("comparison prompts: answers parse into rankings of the shown sites; bad answers throw", () => {
  const img = { inline_data: { mime_type: "image/jpeg", data: "AAAA" } };
  const req = buildPairRequest([{ name: "A", pageText: "x".repeat(5000), image: img }, { name: "B", pageText: "", image: img }]);
  assert.equal(req.parts.filter((p) => p.inline_data).length, 2);
  assert.match(req.options.systemInstruction, /untrusted/);
  assert.ok(req.parts.every((p) => !p.text || p.text.length < 1400), "page text is capped");
  assert.deepEqual(parsePairAnswer({ winner: "B" }, ["u1", "u2"]).ranking, [["u2"], ["u1"]]);
  assert.deepEqual(parsePairAnswer({ winner: "a" }, ["u1", "u2"]).ranking, [["u1"], ["u2"]]);
  assert.equal(parsePairAnswer({ winner: "skip" }, ["u1", "u2"]).ranking, null);
  assert.throws(() => parsePairAnswer({ winner: "C" }, ["u1", "u2"]));
  const batch = buildBatchRequest(["1", "2", "3"].map((n) => ({ name: n, pageText: n, image: img })));
  assert.deepEqual(batch.schema.properties.order.items.enum, ["A", "B", "C"]);
  assert.deepEqual(parseBatchAnswer({ order: ["C", "A", "B"] }, ["u1", "u2", "u3"]).ranking, [["u3"], ["u1"], ["u2"]]);
  for (const order of [["A", "B"], ["A", "A", "B"], ["A", "B", "D"], null]) assert.throws(() => parseBatchAnswer({ order }, ["u1", "u2", "u3"]));
});

test("config: off by default, budgets and flags from the environment", () => {
  const def = rankingConfig({});
  assert.equal(def.enabled, false);
  assert.equal(def.batchedCounts, false);
  assert.deepEqual(def.budget, { one_on_one: 100, batched: 100 });
  assert.equal(def.model, "gemini-3.5-flash-lite");
  const on = rankingConfig({ RANKING_V2: "true", RANKING_BATCHED_COUNTS: "TRUE", RANKING_BUDGET: '{"batched": 40}', RANKING_AI_WEIGHT: "0.3" });
  assert.equal(on.enabled, true);
  assert.equal(on.batchedCounts, true);
  assert.deepEqual(on.budget, { one_on_one: 100, batched: 40 });
  assert.equal(on.aiWeight, 0.3);
  assert.equal(rankingConfig({ RANKING_BUDGET: "not json", RANKING_AI_WEIGHT: "7" }).aiWeight, 0.5);
});

test("places: tied rows share the shown rank, but each view has exactly one gold, silver and bronze", () => {
  // A run of ties at the very top and another across places 3 to 6, the way
  // the AI and People boards look when many sites share a score.
  const rows = [
    { rank: 1, mu: 30, tiedWithNext: true },
    { rank: 2, mu: 30, tiedWithNext: true },
    { rank: 3, mu: 30, tiedWithNext: false },
    { rank: 4, mu: 28, tiedWithNext: true },
    { rank: 5, mu: 28, tiedWithNext: true },
    { rank: 6, mu: 28, tiedWithNext: false },
    { rank: 7, mu: 27, tiedWithNext: false },
  ];
  const shown = shownPlaces(rows);
  assert.deepEqual(
    shown.map((s) => [s.rank, s.tied]),
    [[1, true], [1, true], [1, true], [4, true], [4, true], [4, true], [7, false]]
  );
  const medals = shown.map((s) => medalFor(s.place));
  assert.deepEqual(medals, ["gold", "silver", "bronze", null, null, null, null]);
  for (const m of ["gold", "silver", "bronze"]) assert.equal(medals.filter((x) => x === m).length, 1);
  // Tied by the flag but not by the score as shown: not shared.
  assert.deepEqual(shownPlaces([{ rank: 1, mu: 30.04, tiedWithNext: true }, { rank: 2, mu: 29.8, tiedWithNext: false }]).map((s) => s.rank), [1, 2]);
});
