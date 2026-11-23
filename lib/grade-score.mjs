// A grade's key, kept beside a site's rating for reference (tier_ratings.gkey,
// lib/tiers.mjs entryOf): never in the order (lib/tiers.mjs compareSeed).
//
// Rubric v3 (owner, 2026-11-22): a site's rank comes only from code
// measurements, and Gemini's letter and its dropped scores (the old
// quality score's parts) are no longer asked for or read, for old grades
// too. So the key is the code checks alone: the grade's checks_score
// (resume, GitHub, contact, project links that load, own domain, fresh
// footer; pipeline/rubric.mjs checksScore), 0-100. Before v3 it was the
// AI quality score (80%) and the checks (20%), with Gemini's letter as a
// tie-break.
//
// Pure: no database, no AI request.

/** The checks score counted for a grade without code checks (rubric v1): about the library's median (87 on 2026-11-12). */
export const CHECKS_WHEN_UNKNOWN = 85;

/**
 * A grade's score, 0-100 with two decimals: its code checks score, or
 * CHECKS_WHEN_UNKNOWN for a grade made before the checks existed. Null for
 * no grade, an error sentinel or "not a portfolio".
 */
export function gradeScore(grade) {
  if (!grade || typeof grade !== "object" || grade.error || grade.is_portfolio === false) return null;
  const checks = typeof grade.checks_score === "number" ? Math.min(100, Math.max(0, grade.checks_score)) : CHECKS_WHEN_UNKNOWN;
  return Math.round(checks * 100) / 100;
}

/** The sort key of a grade (higher is better; equal keys are equal places), or null when it can't be scored. */
export function gradeKey(grade) {
  const score = gradeScore(grade);
  return score == null ? null : Math.round(score * 100);
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
