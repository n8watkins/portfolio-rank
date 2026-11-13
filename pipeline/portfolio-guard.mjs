// The strong-signals guard (owner, 2026-11-13): when the AI grade says a
// site is not a portfolio but the code's own facts find most of what a
// portfolio has (pipeline/signals.mjs: at least STRONG_SIGNALS of name,
// projects, about, contact, resume and GitHub), the verdict is not acted on.
// The grade is stored as a portfolio, so it stays listed and ranked
// everywhere a "not a portfolio" verdict would hide it (tiers, boards, the
// sitemap, Play), with the AI's own answer and the reason kept in the grade
// (ai_is_portfolio, review), and the site marked portfolios.needs_review for
// a person to look at.
//
// One place, at grade time (pipeline/rubric.mjs gradeRecord), so every
// reader of is_portfolio follows it without a check of its own.

export const STRONG_SIGNALS = 4;
export const SIGNAL_NAMES = ["name", "projects", "about", "contact", "resume", "github"];
export const REVIEW_KIND = "strong_signals";

/**
 * The grade to store: unchanged unless the AI said is_portfolio=false and
 * `signals.score` is at least STRONG_SIGNALS; then is_portfolio is true,
 * ai_is_portfolio keeps the AI's false, and review says why.
 * @param {Record<string, any>} grade the parsed AI answer, or a full grade
 * @param {{ score?: number } & Record<string, unknown> | null | undefined} signals facts.signals
 */
export function guardVerdict(grade, signals) {
  if (!grade || grade.is_portfolio !== false) return grade;
  const score = Number(signals?.score ?? 0);
  if (!(score >= STRONG_SIGNALS)) return grade;
  const found = SIGNAL_NAMES.filter((k) => signals?.[k] === true);
  return {
    ...grade,
    is_portfolio: true,
    ai_is_portfolio: false,
    review: {
      kind: REVIEW_KIND,
      reason: `The AI said this isn't a portfolio, but the page has ${score} of ${SIGNAL_NAMES.length} portfolio signals${found.length ? ` (${found.join(", ")})` : ""}, so it stays listed until a person checks it.`,
      signals: score,
    },
  };
}

/** True when a stored grade was kept as a portfolio by the guard. */
export const guardedForReview = (grade) => grade?.review?.kind === REVIEW_KIND;
