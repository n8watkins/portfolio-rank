// The plain names of the review queue's rules, for the page and the grade's
// review text (lib/reviews/store.mjs). The stored actor ids stay as they are.
export const RULE_NAMES = {
  "rule:both-pass": "both models said portfolio",
  "rule:gemini-not-portfolio": "Gemini said not a portfolio",
};

/** A rule's plain name, or its id without "rule:" and dashes. */
export const ruleName = (by) => RULE_NAMES[String(by ?? "")] ?? String(by ?? "").replace(/^rule:/, "").replace(/-/g, " ");
