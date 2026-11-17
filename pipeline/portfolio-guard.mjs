// The strong-signals guard (owner, 2026-11-13): when the AI grade says a
// site is not a portfolio but the code's own facts find most of what a
// portfolio has (pipeline/signals.mjs: at least STRONG_SIGNALS of name,
// projects, about, contact, resume and GitHub), the verdict is not acted on.
// The grade is stored as a portfolio, so it stays listed and ranked
// everywhere a "not a portfolio" verdict would hide it (tiers, boards, the
// sitemap, Play), with the AI's own answer and the reason kept in the grade
// (ai_is_portfolio, review), and the site marked portfolios.needs_review; the
// nightly grade writes a pending review row for the owner (lib/reviews/door.mjs,
// owner 2026-11-16), where a junk rule (./junk-rules.mjs) takes this
// protection away.
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

/**
 * A "not a portfolio" answer held for the owner for another reason than the
 * signals (owner, 2026-11-16; lib/reviews/door.mjs): the answer waits for the
 * rule or the owner, the site stays listed meanwhile, and Undo of an automatic
 * removal brings this grade back.
 */
export const HELD_KIND = "held_for_owner";
/** Every review kind that holds a "not a portfolio" for the owner; the SQL below and guardedForReview read this one list. */
export const HELD_KINDS = Object.freeze([REVIEW_KIND, HELD_KIND]);
const HELD = new Set(HELD_KINDS);

/** True when a stored grade keeps a site listed against the AI's "not a portfolio" (the guard, or a hold for the owner). */
export const guardedForReview = (grade) => HELD.has(grade?.review?.kind);

/** SQL (never NULL): the grade in column `col` (JSON) is held for the owner. */
export const HELD_SQL = (col) =>
  `COALESCE((CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.review.kind') END) IN (${HELD_KINDS.map((k) => `'${k}'`).join(", ")}), 0)`;

/**
 * The start of every health reason for a site kept off the list because it
 * is "not a portfolio" (pipeline/health.mjs, the review queue's removals,
 * lib/reviews/store.mjs). pipeline/exclusions.mjs kindOf files such a site as
 * "not_portfolio", and the public Removed page prints the reason.
 */
export const AI_SAYS_NOT_PORTFOLIO = "AI grading says this is not a portfolio";

/** What the AI itself answered to "is it a portfolio": its own answer even when a hold or the owner overrode it. */
export const aiSaysPortfolio = (grade) => (typeof grade?.ai_is_portfolio === "boolean" ? grade.ai_is_portfolio : grade?.is_portfolio !== false);

/**
 * The grade with the AI's "not a portfolio" acted on: is_portfolio false and
 * no hold. A junk rule (pipeline/junk-rules.mjs) uses it to take the guard's
 * protection away from an unedited template.
 */
export function unguarded(grade) {
  if (!grade || aiSaysPortfolio(grade)) return grade;
  const { ai_is_portfolio: _a, review: _r, ...rest } = grade;
  void _a;
  void _r;
  return { ...rest, is_portfolio: false };
}

/** The grade held for the owner: listed (is_portfolio true), the AI's "no" kept in ai_is_portfolio, `reason` in review. */
export function held(grade, reason, extra = {}) {
  return { ...unguarded(grade), is_portfolio: true, ai_is_portfolio: false, review: { kind: HELD_KIND, reason, ...extra } };
}
