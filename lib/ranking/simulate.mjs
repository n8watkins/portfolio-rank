// A seeded simulation of the comparison system, for the tests and the
// offline evaluation (scripts/simulate-ranking.mjs). Every site gets a hidden
// "true quality"; a simulated AI judge and simulated people compare sites
// the way the real ones would (noisy, the AI with a small first-shown bias),
// and the matchmaking module picks the AI's pairs each day from the AI view.
// The output is in the export format, so it goes through exactly the same
// recompute as real data.
import { MU, PROMPT_VERSION_BATCHED, PROMPT_VERSION_ONE_ON_ONE, SIGMA_UNSURE, TIER_QUALITY_CENTER, BATCH_SIZE } from "./config.mjs";
import { rateRanking, seedFromGrade } from "./engine.mjs";
import { planBatches, planPairs, pairKey } from "./matchmaking.mjs";
import { createRng, gaussian, randInt } from "./prng.mjs";

const TIER_Z = { S: 2, A: 1, B: 0, C: -1, D: -2 };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** A tier from a quality on the z scale, with the AI grader's noise (about 5% S, 20% A, 40% B, 25% C, 10% D). */
export function tierFor(z) {
  if (z > 1.65) return "S";
  if (z > 0.6) return "A";
  if (z > -0.55) return "B";
  if (z > -1.3) return "C";
  return "D";
}

/**
 * Builds the population. `sites`: [{url, grade?}]; a real grade is kept and
 * the hidden truth is drawn around it; a site without one gets a simulated
 * grade drawn from its truth (marked simulated: true).
 */
export function population(sites, rng, { gradeNoise = 0.45 } = {}) {
  return sites.map((s) => {
    if (s.grade?.tier && s.grade.tier in TIER_Z) {
      const q = typeof s.grade.quality_score === "number" ? s.grade.quality_score : null;
      const within = q == null ? 0 : (q - TIER_QUALITY_CENTER[s.grade.tier]) * 0.6;
      return { ...s, truth: TIER_Z[s.grade.tier] + within + gaussian(rng) * gradeNoise, simulatedGrade: false };
    }
    const truth = gaussian(rng);
    const seen = truth + gaussian(rng) * gradeNoise;
    const tier = tierFor(seen);
    const quality = Math.round(Math.min(5, Math.max(1, TIER_QUALITY_CENTER[tier] + (seen - TIER_Z[tier]) * 0.5 + gaussian(rng) * 0.15)) * 100) / 100;
    return {
      ...s,
      truth,
      simulatedGrade: true,
      grade: { tier, quality_score: quality, rubric_version: 2, model: "gemini-3.5-flash-lite", is_portfolio: true },
    };
  });
}

/** The simulated AI judge on a one-on-one: P(first wins) = sigmoid(k * (t1 - t2) + bias). */
export const aiPick = (rng, a, b, { k = 1.4, bias = 0.15 } = {}) => (rng() < sigmoid(k * (a.truth - b.truth) + bias) ? 0 : 1);
/** Simulated people: noisier, with personal taste. */
export const humanPick = (rng, a, b, { k = 1.0, taste = 0.6 } = {}) => (rng() < sigmoid(k * (a.truth - b.truth) + gaussian(rng) * taste) ? 0 : 1);

/** A batched answer: a Plackett-Luce draw from the truths (noisier than one-on-one: many images at once). */
export function batchOrder(rng, sites, { k = 1.1 } = {}) {
  const left = [...sites];
  const order = [];
  while (left.length) {
    const w = left.map((s, i) => Math.exp(k * s.truth + (i === 0 ? 0.1 : 0)));
    const total = w.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let i = 0;
    for (; i < w.length - 1; i++) {
      r -= w[i];
      if (r < 0) break;
    }
    order.push(left.splice(i, 1)[0]);
  }
  return order;
}

const dayIso = (start, d, minute) => new Date(Date.parse(`${start}T13:00:00Z`) + d * 86400000 + minute * 60000).toISOString();

/**
 * Runs the daily system for `days` days.
 *   sites            [{url, grade?}]
 *   prior            comparisons already stored (e.g. real votes), replayed first
 *   aiPerDay         one-on-one AI comparisons a day (matchmaking)
 *   batchedPerDay    batched AI comparisons a day (stored, experiment only)
 *   humansPerDay     human votes a day (random pairs, as the app serves them)
 *   improve          {url, day, truth}: the site's page changes on that day
 *                    (its truth jumps and its uncertainty resets)
 * Returns the export-format input plus the truths.
 */
export function simulate({ sites, prior = [], days = 56, start = "2026-09-14", seed = "sim", aiPerDay = 100, batchedPerDay = 100, humansPerDay = 30, improve = null, reset = true }) {
  const rng = createRng(`simulate:${seed}`);
  const pop = population(sites, rng);
  const byUrl = new Map(pop.map((s) => [s.url, s]));
  // The AI view, kept incrementally so matchmaking sees today's ratings.
  const ai = new Map(pop.map((s) => [s.url, (({ mu, sigma }) => ({ mu, sigma }))(seedFromGrade(s.grade))]));
  const get = (u) => ai.get(u) ?? { mu: MU, sigma: SIGMA_UNSURE };
  const comparisons = [...prior];
  const resets = [];
  const trajectory = []; // the improved site's AI-view rank after each of its comparisons
  let id = Math.max(0, ...prior.map((c) => Number(c.id) || 0));
  const recent = new Map();
  for (const c of prior) {
    if (c.rater_type !== "ai" || !Array.isArray(c.ranking)) continue;
    for (const [u, r] of rateRanking(get, c.ranking, 1) ?? []) ai.set(u, r);
  }

  for (let d = 0; d < days; d++) {
    if (improve && d === improve.day) {
      byUrl.get(improve.url).truth = improve.truth;
      if (reset) {
        const at = dayIso(start, d, -60);
        resets.push({ url: improve.url, at, reason: "page_changed" });
        const r = get(improve.url);
        ai.set(improve.url, { mu: r.mu, sigma: Math.max(r.sigma, SIGMA_UNSURE) });
      }
    }
    const pool = pop.map((s) => ({ url: s.url, ...get(s.url) }));
    const cutoff = d - 30;
    const recentSet = new Set([...recent].filter(([, day]) => day > cutoff).map(([k]) => k));
    const past = comparisons.filter((c) => c.rater_type === "ai" && c.method === "one_on_one" && Array.isArray(c.shown) && c.shown.length === 2).slice(-500);
    const daySeed = `${seed}:${d}`;
    let minute = 0;
    for (const p of planPairs({ sites: pool, n: aiPerDay, seed: daySeed, recent: recentSet, past })) {
      const [a, b] = p.shown.map((u) => byUrl.get(u));
      const created_at = dayIso(start, d, minute++);
      if (rng() < 0.02) {
        comparisons.push({ id: ++id, created_at, rater_type: "ai", model: "gemini-3.5-flash-lite", prompt_version: PROMPT_VERSION_ONE_ON_ONE, method: "one_on_one", shown: p.shown, ranking: null, outcome: "skip", starred: 0, experiment: null, match_seed: daySeed, match_kind: p.kind });
        continue;
      }
      const first = aiPick(rng, a, b) === 0;
      const ranking = first ? [[a.url], [b.url]] : [[b.url], [a.url]];
      comparisons.push({ id: ++id, created_at, rater_type: "ai", rater_id: "ai:gemini-3.5-flash-lite", model: "gemini-3.5-flash-lite", prompt_version: PROMPT_VERSION_ONE_ON_ONE, method: "one_on_one", shown: p.shown, ranking, outcome: "ranked", starred: 0, experiment: null, match_seed: daySeed, match_kind: p.kind });
      recent.set(pairKey(a.url, b.url), d);
      rateRanking(get, ranking, 1).forEach(([u, r]) => ai.set(u, r));
      if (improve && d >= improve.day && (a.url === improve.url || b.url === improve.url)) {
        const mu = get(improve.url).mu;
        let rank = 1;
        for (const r of ai.values()) if (r.mu > mu) rank++;
        trajectory.push({ day: d, comparisons: trajectory.length + 1, rank, mu: Math.round(mu * 100) / 100 });
      }
    }
    for (const g of planBatches({ sites: pool, n: batchedPerDay, size: BATCH_SIZE, seed: daySeed })) {
      const order = batchOrder(rng, g.shown.map((u) => byUrl.get(u)));
      comparisons.push({ id: ++id, created_at: dayIso(start, d, minute++), rater_type: "ai", rater_id: "ai:gemini-3.5-flash-lite", model: "gemini-3.5-flash-lite", prompt_version: PROMPT_VERSION_BATCHED, method: "batched", shown: g.shown, ranking: order.map((s) => [s.url]), outcome: "ranked", starred: 0, experiment: null, match_seed: daySeed, match_kind: g.kind });
    }
    for (let h = 0; h < humansPerDay; h++) {
      const a = pop[randInt(rng, pop.length)];
      const b = pop[randInt(rng, pop.length)];
      if (a === b) continue;
      const first = humanPick(rng, a, b) === 0;
      comparisons.push({ id: ++id, created_at: dayIso(start, d, 300 + h * 7), rater_type: "human", rater_id: `user:${randInt(rng, 200)}`, model: null, prompt_version: null, method: "one_on_one", shown: [a.url, b.url], ranking: first ? [[a.url], [b.url]] : [[b.url], [a.url]], outcome: "ranked", starred: rng() < 0.05 ? 1 : 0, experiment: null, match_seed: null, match_kind: null });
    }
  }
  return {
    sites: pop.map((s) => ({ url: s.url, grade: s.grade, listed: true })),
    comparisons,
    resets,
    truth: new Map(pop.map((s) => [s.url, s.truth])),
    trajectory,
    simulatedGrades: pop.filter((s) => s.simulatedGrade).length,
  };
}

/** Spearman rank correlation between a board and the hidden truth. */
export function spearman(board, truth) {
  const rows = board.filter((r) => truth.has(r.url));
  const n = rows.length;
  if (n < 3) return null;
  const byTruth = [...rows].sort((a, b) => truth.get(b.url) - truth.get(a.url));
  const trueRank = new Map(byTruth.map((r, i) => [r.url, i]));
  let d2 = 0;
  rows.forEach((r, i) => {
    d2 += (i - trueRank.get(r.url)) ** 2;
  });
  return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 1000) / 1000;
}
