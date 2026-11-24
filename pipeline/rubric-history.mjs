// Grades are never overwritten silently. When a site is graded again (its
// one fresh grade after the owner's review, a manual tool, or --force), its
// previous grade moves to rubric_history first.

import { RUBRIC_HISTORY_TABLES, applyTables } from "../lib/pipeline-schema.mjs";
import { guardedForReview } from "./portfolio-guard.mjs";
import { geminiAnswered } from "./rubric.mjs";

export async function ensureRubricHistory(db) {
  await applyTables(db, RUBRIC_HISTORY_TABLES);
}

/** Parse a stored rubric; null for missing, unparseable, error sentinels and anything that is not a Gemini answer. */
export function parseRubric(json) {
  if (json == null) return null;
  try {
    const r = JSON.parse(String(json));
    return geminiAnswered(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Statements that replace a site's grade: the old grade (if a real one) goes
 * to rubric_history, the new one into portfolios.ai_rubric, in one batch.
 */
export function replaceGradeStatements(url, oldJson, newRubric, now = new Date()) {
  const stmts = [];
  const old = parseRubric(oldJson);
  if (old) {
    stmts.push({
      sql: `INSERT INTO rubric_history (url, model, tier, is_portfolio, rubric, judged_at, replaced_at, replaced_by_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        url,
        old.model ?? null,
        old.tier ?? null,
        old.is_portfolio == null ? null : old.is_portfolio ? 1 : 0,
        String(oldJson),
        old.judged_at ?? null,
        now.toISOString(),
        newRubric.model ?? null,
      ],
    });
  }
  stmts.push({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?", args: [JSON.stringify(newRubric), url] });
  // Kept as a portfolio against the AI's verdict (./portfolio-guard.mjs): a person looks at it.
  if (guardedForReview(newRubric)) stmts.push({ sql: "UPDATE portfolios SET needs_review = 1 WHERE url = ?", args: [url] });
  return stmts;
}

/**
 * Statements that clear a site's grade so the nightly "grade new" queue grades
 * it again (the owner's review queue, lib/reviews/store.mjs, when a grade has
 * no tier to rank on). A grade worth keeping moves to rubric_history first,
 * as with replaceGradeStatements.
 */
export function clearGradeStatements(url, oldJson, now = new Date()) {
  const stmts = [];
  const old = parseRubric(oldJson);
  if (old) {
    stmts.push({
      sql: `INSERT INTO rubric_history (url, model, tier, is_portfolio, rubric, judged_at, replaced_at, replaced_by_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [url, old.model ?? null, old.tier ?? null, old.is_portfolio == null ? null : old.is_portfolio ? 1 : 0, String(oldJson), old.judged_at ?? null, now.toISOString()],
    });
  }
  stmts.push({ sql: "UPDATE portfolios SET ai_rubric = NULL WHERE url = ?", args: [url] });
  return stmts;
}
