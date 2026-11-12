// Tiers by rank (owner decision 2026-11-12): the tier letter a portfolio
// shows comes from where it ranks in the graded library, not from the
// letter Gemini picks. Gemini's own letter (grade.tier) stays in the stored
// grade: it still seeds the leaderboard's ratings (lib/ranking/engine.mjs)
// and breaks ties here, but it is never shown as the tier any more.
//
// How a portfolio is ranked, in plain words:
//   1. Its score (0-100): the five AI scores, averaged with the rubric's
//      weights (pipeline/rubric.mjs quality_score, 1-5, put on 0-100), count
//      for 80%; the code checks (resume, GitHub, contact, project links that
//      load, own domain, fresh footer, not a known template: checks_score,
//      0-100) count for 20%. A grade from before the code checks existed
//      counts the typical checks result (CHECKS_WHEN_UNKNOWN).
//   2. Equal scores are split by Gemini's own letter (S above A ...).
//      Portfolios still equal after that share a place and always get the
//      same tier.
//   3. Its place in the library is the middle of its group of equals, as a
//      share of the library: "top 1.4%". The ladder below turns that into a
//      tier.
//   4. A small library can't hand out tiers it has no room for: a tier is
//      only given when its band holds at least one whole portfolio (the top
//      2% needs 50 graded portfolios, the top 5% 20, the bottom 5% 20, and so
//      on); otherwise the portfolio gets the next tier toward B.
//
// The library is the listed, healthy, graded portfolios that are not
// flagged "not a portfolio" (the same pool "Grade my portfolio" compares
// against, lib/grader/report.mjs gradedPool). Everything here is pure: the
// database side is lib/tiers-store.mjs. No AI request is involved.
import { AI_CRITERIA } from "../pipeline/rubric.mjs";

// ---------------------------------------------------------------------------
// The owner's settings: change these to tune the tiers. A change takes
// effect at the next refresh (hourly, lib/tiers-store.mjs refreshTiers).
// ---------------------------------------------------------------------------

/**
 * The ladder, best first: each tier and the "top N%" of the library it
 * reaches down to. B is the broad middle; C and D are the bottom 20% and
 * the bottom 5%.
 */
export const TIER_LADDER = [
  { tier: "SSS", top: 2, name: "Elite", note: "The top 2%." },
  { tier: "SS", top: 5, name: "Outstanding", note: "The top 5%." },
  { tier: "S", top: 10, name: "Exceptional", note: "The top 10%." },
  { tier: "A", top: 20, name: "Strong", note: "The top 20%." },
  { tier: "B", top: 80, name: "Solid", note: "Most portfolios." },
  { tier: "C", top: 95, name: "Weak", note: "The next 15%." },
  { tier: "D", top: 100, name: "Needs work", note: "The bottom 5%." },
];

/** The tiers whose letter is shown publicly (the top tiers through B); lower ones read "Graded, below the top tiers". */
export const PUBLIC_THROUGH = "B";

/** How much of the score each part makes up (they sum to 1). */
export const SCORE_WEIGHTS = { quality: 0.8, checks: 0.2 };

/** The checks score counted for a grade without code checks (rubric v1): about the library's median (87 on 2026-11-12). */
export const CHECKS_WHEN_UNKNOWN = 85;

// ---------------------------------------------------------------------------

/** Every tier, best first. */
export const TIERS = TIER_LADDER.map((t) => t.tier);
/** The tiers shown publicly, best first. */
export const PUBLIC_TIERS = TIERS.slice(0, TIERS.indexOf(PUBLIC_THROUGH) + 1);
/** What a lower tier says in public, instead of its letter. */
export const BELOW_TOP_TIERS = "Graded, below the top tiers";

/** Gemini's letters, which break ties (S above A ...). */
const AI_LETTER_VALUE = { S: 4, A: 3, B: 2, C: 1, D: 0 };

/** True for one of the tier letters (SSS to D). */
export const isTier = (t) => typeof t === "string" && TIERS.includes(t);
/** True for a tier whose letter is shown publicly. */
export const isPublicTier = (t) => typeof t === "string" && PUBLIC_TIERS.includes(t);
/** The tier's place on the ladder, 0 for SSS; -1 for anything else. */
export const tierIndex = (t) => TIERS.indexOf(t);
/** A tier as a number for averages and comparisons: D 1 up to SSS 7; null for anything else. */
export const tierValue = (t) => (isTier(t) ? TIERS.length - TIERS.indexOf(t) : null);
/** The tier nearest a value from tierValue (an average), or null. */
export const tierOfValue = (v) =>
  typeof v === "number" && Number.isFinite(v) ? TIERS[TIERS.length - Math.min(TIERS.length, Math.max(1, Math.round(v)))] : null;

/**
 * The tier a stored grade shows: its rank tier (grade.rank.tier, written by
 * lib/tiers-store.mjs), or null when it has none yet, is not a portfolio or
 * is an error sentinel. Never Gemini's own letter.
 */
export function tierOf(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const t = grade.rank?.tier;
  return isTier(t) ? t : null;
}

/** The AI quality score (1-5) of a grade: stored by rubric v2, else the weighted mean of the AI axes (v1 grades). */
export function qualityOf(grade) {
  if (typeof grade?.quality_score === "number") return grade.quality_score;
  let sum = 0;
  let of = 0;
  for (const c of AI_CRITERIA) {
    const v = grade?.[c.id];
    const s = typeof v === "number" ? v : v?.score;
    if (typeof s !== "number") continue;
    sum += s * c.weight;
    of += c.weight;
  }
  return of ? sum / of : null;
}

/**
 * A grade's score, 0-100 with two decimals, or null when the grade can't be
 * ranked (an error sentinel, no AI scores, or "not a portfolio").
 */
export function rankScore(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const q = qualityOf(grade);
  if (typeof q !== "number") return null;
  const quality = Math.min(100, Math.max(0, (q - 1) * 25));
  const checks = typeof grade.checks_score === "number" ? Math.min(100, Math.max(0, grade.checks_score)) : CHECKS_WHEN_UNKNOWN;
  return Math.round((SCORE_WEIGHTS.quality * quality + SCORE_WEIGHTS.checks * checks) * 100) / 100;
}

/**
 * The sort key of a grade: its score, then Gemini's letter, as one integer
 * (higher is better; equal keys are equal places). Null when unrankable.
 */
export function rankKey(grade) {
  const score = rankScore(grade);
  if (score == null) return null;
  const letter = AI_LETTER_VALUE[String(grade.tier ?? "").toUpperCase()] ?? 0;
  return Math.round(score * 100) * 10 + letter;
}

/** The place as a share of the library (0-100]: the middle of the portfolio's slot. */
const shareAt = (position, total) => (100 * (position - 0.5)) / total;

/**
 * The tier at a position (1 = best, the middle of a group of equals; may be
 * fractional) in a library of `total`. A tier above B needs its whole band
 * ("top N%") to hold at least one portfolio, and a tier below B its bottom
 * share; otherwise the next tier toward B is given.
 */
export function tierAt(position, total) {
  if (!(total > 0)) return null;
  const share = shareAt(position, total);
  let i = TIER_LADDER.findIndex((t) => share <= t.top);
  if (i < 0) i = TIER_LADDER.length - 1;
  const mid = TIERS.indexOf(PUBLIC_THROUGH);
  while (i < mid && (TIER_LADDER[i].top * total) / 100 < 1) i++;
  while (i > mid && ((100 - TIER_LADDER[i - 1].top) * total) / 100 < 1) i--;
  return TIERS[i];
}

/** "Top N%" for a position: whole percent, rounded up so it never claims more than the tier (1 at least). */
export const topPctAt = (position, total) => Math.max(1, Math.min(100, Math.ceil(shareAt(position, total) - 1e-9)));

/** How many keys of a list sorted best first are above `key`, and how many equal it (binary search). */
function countAround(keysDesc, key) {
  const firstAtMost = (k) => {
    let lo = 0;
    let hi = keysDesc.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (keysDesc[m] > k) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const above = firstAtMost(key);
  const notBelow = firstAtMost(key - 1);
  return { above, equal: notBelow - above };
}

/**
 * Where a key lands in a library (`keysDesc`: every member's key, best
 * first). `member` says the key is one of them (a listed portfolio);
 * otherwise it is placed as if added (a visitor's grade, a delisted site).
 * Returns { tier, top, position, rank, total } or null for a null key.
 */
export function placeKey(keysDesc, key, { member = false } = {}) {
  if (key == null) return null;
  const { above, equal } = countAround(keysDesc, key);
  const group = member ? Math.max(1, equal) : equal + 1;
  const total = member ? keysDesc.length : keysDesc.length + 1;
  const position = above + (group + 1) / 2;
  return { tier: tierAt(position, total), top: topPctAt(position, total), position, rank: above + 1, total };
}

/** The library's keys, best first, from a list of grades or keys. */
export const sortedKeys = (keys) => keys.filter((k) => typeof k === "number").sort((a, b) => b - a);

/**
 * The stored rank of a grade placed in a library: { tier, score, top } (what
 * lib/tiers-store.mjs writes into the grade as `rank`), or null.
 */
export function rankOf(grade, keysDesc, { member = false } = {}) {
  const key = rankKey(grade);
  const place = placeKey(keysDesc, key, { member });
  return place ? { tier: place.tier, score: rankScore(grade), top: place.top } : null;
}

/** The share of a library in each tier, for the admin and the docs: { tier: count }. */
export function distribution(keysDesc) {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let i = 0;
  while (i < keysDesc.length) {
    let j = i;
    while (j < keysDesc.length && keysDesc[j] === keysDesc[i]) j++;
    out[tierAt(i + (j - i + 1) / 2, keysDesc.length)] += j - i;
    i = j;
  }
  return out;
}
