// The rating engine: OpenSkill (Weng-Lin, Plackett-Luce model) through the
// openskill package (MIT, philihp/openskill.js), with PortfolioRank's seeds,
// weights and board. Pure: no database, no clock, no randomness.
//
// Each site has a rating: a mean (mu, how good it seems) and an uncertainty
// (sigma, how sure we are). A comparison is a ranking of two or more sites,
// best first, and moves the means of the sites in it by more when they are
// unsure and less when they are settled.
import { rate } from "openskill";
import {
  BETA,
  CONFIDENT_SIGMA,
  CURRENT_RUBRIC_VERSION,
  MU,
  PRIMARY_GRADE_MODEL,
  PROVISIONAL_SIGMA,
  QUALITY_NUDGE_MAX,
  QUALITY_NUDGE_PER_POINT,
  SEED_SIGMA,
  SEED_SIGMA_OLD_GRADE,
  SETTLED_SIGMA,
  SIGMA,
  SIGMA_UNSURE,
  TAU,
  TIE_WIN_PROBABILITY,
  TIER_MU,
  TIER_QUALITY_CENTER,
} from "./config.mjs";

const OPTIONS = { mu: MU, sigma: SIGMA, beta: BETA, tau: TAU };

/** The quality score of a grade (1-5): stored by rubric v2, else the weighted mean of the AI axes (v1 grades). */
export function gradeQuality(grade) {
  if (!grade || typeof grade !== "object") return null;
  if (typeof grade.quality_score === "number") return grade.quality_score;
  // Same weights as pipeline/rubric.mjs CRITERIA (by: "ai").
  const weights = { visual_design: 0.3, five_second_test: 0.2, storytelling: 0.25, writing: 0.15, memorability: 0.1 };
  let sum = 0;
  let of = 0;
  for (const [id, w] of Object.entries(weights)) {
    const v = grade[id];
    const s = typeof v === "number" ? v : v?.score;
    if (typeof s !== "number") continue;
    sum += s * w;
    of += w;
  }
  return of ? Math.round((100 * sum) / of) / 100 : null;
}

/**
 * The starting rating from a site's AI grade (owner decision 2026-11-10):
 * the tier sets the mean (S 33, A 29, B 25, C 21, D 17), the quality score
 * nudges it within the tier, and the sigma says how much the grade is
 * trusted. No grade (or an unusable one) starts "unsure" at the neutral mean.
 */
export function seedFromGrade(grade) {
  const tier = typeof grade?.tier === "string" ? grade.tier.toUpperCase() : null;
  if (!tier || !(tier in TIER_MU)) {
    return { mu: MU, sigma: SIGMA_UNSURE, basis: "none", tier: null, quality: null };
  }
  const quality = gradeQuality(grade);
  let nudge = 0;
  if (typeof quality === "number") {
    nudge = (quality - TIER_QUALITY_CENTER[tier]) * QUALITY_NUDGE_PER_POINT;
    nudge = Math.max(-QUALITY_NUDGE_MAX, Math.min(QUALITY_NUDGE_MAX, nudge));
  }
  const current =
    Number(grade.rubric_version ?? 1) >= CURRENT_RUBRIC_VERSION && grade.model === PRIMARY_GRADE_MODEL;
  return {
    mu: round(TIER_MU[tier] + nudge),
    sigma: current ? SEED_SIGMA : SEED_SIGMA_OLD_GRADE,
    basis: "grade",
    tier,
    quality,
  };
}

/** The seed of a view that ignores grades (People): everyone starts equal and unsure. */
export const neutralSeed = () => ({ mu: MU, sigma: SIGMA_UNSURE, basis: "none", tier: null, quality: null });

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Checks a stored ranking: an array of groups, best first, each a non-empty
 * array of distinct site URLs; sites in one group tied. At least two sites.
 */
export function validRanking(ranking) {
  if (!Array.isArray(ranking) || ranking.length < 1) return false;
  const seen = new Set();
  for (const group of ranking) {
    if (!Array.isArray(group) || group.length < 1) return false;
    for (const url of group) {
      if (typeof url !== "string" || !url || seen.has(url)) return false;
      seen.add(url);
    }
  }
  return seen.size >= 2;
}

/**
 * Applies one comparison. `get(url)` returns the current {mu, sigma}.
 * Returns [url, {mu, sigma}] for every site in it, or null for an invalid
 * ranking. A weight below 1 moves each rating part of the way (mean and
 * variance interpolated); a weight of 2 applies the result twice.
 */
export function rateRanking(get, ranking, weight = 1) {
  if (!validRanking(ranking) || !(weight > 0)) return null;
  const urls = [];
  const ranks = [];
  ranking.forEach((group, i) => {
    for (const url of group) {
      urls.push(url);
      ranks.push(i + 1);
    }
  });
  let current = urls.map((u) => {
    const r = get(u);
    return { mu: r.mu, sigma: r.sigma };
  });
  for (let w = weight; w > 1e-9; w -= 1) {
    const step = Math.min(1, w);
    const out = rate(
      current.map((r) => [r]),
      { ...OPTIONS, rank: ranks }
    ).map((team) => team[0]);
    current = current.map((before, i) => (step === 1 ? out[i] : partial(before, out[i], step)));
  }
  return urls.map((u, i) => [u, current[i]]);
}

function partial(before, after, step) {
  const variance = before.sigma ** 2 + step * (after.sigma ** 2 - before.sigma ** 2);
  return { mu: before.mu + step * (after.mu - before.mu), sigma: Math.sqrt(Math.max(variance, 1e-6)) };
}

/** Chance that a beats b in a one-on-one under the Plackett-Luce model. */
export function winProbability(a, b) {
  const c = Math.sqrt(a.sigma ** 2 + b.sigma ** 2 + 2 * BETA ** 2);
  return 1 / (1 + Math.exp((b.mu - a.mu) / c));
}

/** Confidence label from sigma. "confident" and "settled" count as enough evidence. */
export function confidenceOf(sigma) {
  if (sigma <= SETTLED_SIGMA) return "settled";
  if (sigma <= CONFIDENT_SIGMA) return "confident";
  if (sigma <= PROVISIONAL_SIGMA) return "provisional";
  return "unsure";
}

export const hasEnoughEvidence = (sigma) => sigma <= CONFIDENT_SIGMA;

/**
 * A board: the given ratings sorted by mean (higher first; ties by lower
 * sigma, then URL, so the order is deterministic). Ranked by the mean, not by
 * a conservative mu - k*sigma, so a site whose uncertainty was reset after a
 * redesign keeps its place while it is re-measured; the uncertainty is shown
 * as a confidence label and a 95% range instead.
 * `entries`: iterable of [url, {mu, sigma, ...counts}].
 */
export function buildBoard(entries) {
  const rows = [...entries]
    .map(([url, r]) => ({ url, ...r }))
    .sort((a, b) => b.mu - a.mu || a.sigma - b.sigma || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return rows.map((r, i) => {
    const next = rows[i + 1];
    const pNext = next ? winProbability(r, next) : null;
    return {
      ...r,
      rank: i + 1,
      mu: round(r.mu),
      sigma: round(r.sigma),
      low: round(r.mu - 2 * r.sigma, 2),
      high: round(r.mu + 2 * r.sigma, 2),
      confidence: confidenceOf(r.sigma),
      tiedWithNext: pNext !== null && pNext < TIE_WIN_PROBABILITY,
    };
  });
}
