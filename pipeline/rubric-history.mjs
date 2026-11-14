// Grades are never overwritten silently. When a site is re-graded (by the
// re-grade queues, or --force), its previous grade moves to rubric_history
// first. Every re-grade of a 3.1 Flash-Lite grade by 3.5 Flash-Lite therefore
// yields a free 3.1-vs-3.5 pair, which scripts/grade-compare.mjs reports on.
//
// Two re-grade queues, both after new and ungraded sites:
//   regradeQueue         grades not made by the primary model (3.1 -> 3.5)
//   versionRegradeQueue  grades by the primary model from an older rubric
//                        version (pipeline/rubric.mjs RUBRIC_VERSION); lowest
//                        priority, and only when RUBRIC_REGRADE is "true"

import { RUBRIC_HISTORY_TABLES, applyTables } from "../lib/pipeline-schema.mjs";
import { ACTIVE } from "./roster.mjs";
import { guardedForReview } from "./portfolio-guard.mjs";

export async function ensureRubricHistory(db) {
  await applyTables(db, RUBRIC_HISTORY_TABLES);
}

/** Parse a stored rubric; null for missing, unparseable or error sentinels. */
export function parseRubric(json) {
  if (json == null) return null;
  try {
    const r = JSON.parse(String(json));
    return r && typeof r === "object" && !r.error && r.tier ? r : null;
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

/**
 * The re-grade queue: listed, healthy, captured sites whose current grade was
 * not made by `primary` (older grades without a model count too), oldest
 * grade first. Error sentinels are not grades and are left alone. `where`
 * (an SQL fragment starting with AND, on the portfolios table) narrows it,
 * with its arguments in `whereArgs`.
 */
export async function regradeQueue(db, { primary, limit, where = "", whereArgs = [] }) {
  if (limit <= 0) return [];
  const res = await db.execute({
    sql: `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            AND json_valid(ai_rubric)
            AND json_extract(ai_rubric, '$.error') IS NULL
            AND json_extract(ai_rubric, '$.tier') IS NOT NULL
            AND COALESCE(json_extract(ai_rubric, '$.model'), '') != ?
            ${where}
          ORDER BY COALESCE(json_extract(ai_rubric, '$.judged_at'), ''), url
          LIMIT ?`,
    args: [primary, ...whereArgs, limit],
  });
  return res.rows;
}

/**
 * The rubric-version re-grade queue (lowest priority): listed, healthy,
 * captured sites whose grade was made by `primary` with a rubric older than
 * `version` (grades from before versions were recorded count as 1), oldest
 * grade first. Grades by other models are on regradeQueue already.
 */
export async function versionRegradeQueue(db, { primary, version, limit, where = "", whereArgs = [] }) {
  if (limit <= 0) return [];
  const res = await db.execute({
    sql: `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            AND json_valid(ai_rubric)
            AND json_extract(ai_rubric, '$.error') IS NULL
            AND json_extract(ai_rubric, '$.tier') IS NOT NULL
            AND json_extract(ai_rubric, '$.model') = ?
            AND COALESCE(json_extract(ai_rubric, '$.rubric_version'), 1) < ?
            ${where}
          ORDER BY COALESCE(json_extract(ai_rubric, '$.judged_at'), ''), url
          LIMIT ?`,
    args: [primary, version, ...whereArgs, limit],
  });
  return res.rows;
}
