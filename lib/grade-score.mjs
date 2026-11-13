// The grade's score: the report card's standing (owner decisions
// 2026-11-12). The Gemini grade no longer sets the tier letter (that is the
// ELO from face-offs, lib/tiers.mjs); it is the report card, and this is how
// the report says where the grade itself stands ("your grade: top 12% of
// graded portfolios") and how many places a fix should gain.
//
// The score (0-100): the five AI scores, averaged with the rubric's weights
// (pipeline/rubric.mjs quality_score, 1-5, put on 0-100), count for 80%; the
// code checks (resume, GitHub, contact, project links that load, own domain,
// fresh footer, not a known template: checks_score, 0-100) count for 20%. A
// grade from before the code checks existed counts the typical checks result.
//
// Pure: no database, no AI request.
import { AI_CRITERIA } from "../pipeline/rubric.mjs";

/** How much of the score each part makes up (they sum to 1). */
export const SCORE_WEIGHTS = { quality: 0.8, checks: 0.2 };

/** The checks score counted for a grade without code checks (rubric v1): about the library's median (87 on 2026-11-12). */
export const CHECKS_WHEN_UNKNOWN = 85;

/** Gemini's letters, which break ties between equal scores (S above A ...). */
const AI_LETTER_VALUE = { S: 4, A: 3, B: 2, C: 1, D: 0 };

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
 * scored (an error sentinel, no AI scores, or "not a portfolio").
 */
export function gradeScore(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const q = qualityOf(grade);
  if (typeof q !== "number") return null;
  const quality = Math.min(100, Math.max(0, (q - 1) * 25));
  const checks = typeof grade.checks_score === "number" ? Math.min(100, Math.max(0, grade.checks_score)) : CHECKS_WHEN_UNKNOWN;
  return Math.round((SCORE_WEIGHTS.quality * quality + SCORE_WEIGHTS.checks * checks) * 100) / 100;
}

/**
 * The sort key of a grade: its score, then Gemini's letter, as one integer
 * (higher is better; equal keys are equal places). Null when it can't be scored.
 */
export function gradeKey(grade) {
  const score = gradeScore(grade);
  if (score == null) return null;
  const letter = AI_LETTER_VALUE[String(grade.tier ?? "").toUpperCase()] ?? 0;
  return Math.round(score * 100) * 10 + letter;
}

/**
 * Where a grade's key stands among other grades' keys, as if added to them:
 * { rank, total, topPct, ahead }. `rank` is its place (1 = best, ties take
 * the best place), `topPct` the "top N%" of the middle of its group of
 * equals (whole percent, rounded up, at least 1) and `ahead` the share of
 * the others it is ahead of. Null without a key.
 */
export function standing(keys, key) {
  if (typeof key !== "number") return null;
  let above = 0;
  let equal = 0;
  for (const k of keys) {
    if (typeof k !== "number") continue;
    if (k > key) above++;
    else if (k === key) equal++;
  }
  const others = keys.filter((k) => typeof k === "number").length;
  const total = others + 1;
  const position = above + (equal + 2) / 2;
  return {
    rank: above + 1,
    total,
    topPct: Math.max(1, Math.min(100, Math.ceil((100 * (position - 0.5)) / total - 1e-9))),
    ahead: Math.round((100 * (total - position)) / total),
  };
}
