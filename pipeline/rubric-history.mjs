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

import { ACTIVE } from "./roster.mjs";

export async function ensureRubricHistory(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS rubric_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    model TEXT,
    tier TEXT,
    is_portfolio INTEGER,
    rubric TEXT NOT NULL,
    judged_at TEXT,
    replaced_at TEXT NOT NULL,
    replaced_by_model TEXT
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS rubric_history_url_idx ON rubric_history (url)");
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
  return stmts;
}

/**
 * The re-grade queue: listed, healthy, captured sites whose current grade was
 * not made by `primary` (older grades without a model count too), oldest
 * grade first. Error sentinels are not grades and are left alone.
 */
export async function regradeQueue(db, { primary, limit }) {
  if (limit <= 0) return [];
  const res = await db.execute({
    sql: `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            AND json_valid(ai_rubric)
            AND json_extract(ai_rubric, '$.error') IS NULL
            AND json_extract(ai_rubric, '$.tier') IS NOT NULL
            AND COALESCE(json_extract(ai_rubric, '$.model'), '') != ?
          ORDER BY COALESCE(json_extract(ai_rubric, '$.judged_at'), ''), url
          LIMIT ?`,
    args: [primary, limit],
  });
  return res.rows;
}

/**
 * The rubric-version re-grade queue (lowest priority): listed, healthy,
 * captured sites whose grade was made by `primary` with a rubric older than
 * `version` (grades from before versions were recorded count as 1), oldest
 * grade first. Grades by other models are on regradeQueue already.
 */
export async function versionRegradeQueue(db, { primary, version, limit }) {
  if (limit <= 0) return [];
  const res = await db.execute({
    sql: `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
          WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
            AND json_valid(ai_rubric)
            AND json_extract(ai_rubric, '$.error') IS NULL
            AND json_extract(ai_rubric, '$.tier') IS NOT NULL
            AND json_extract(ai_rubric, '$.model') = ?
            AND COALESCE(json_extract(ai_rubric, '$.rubric_version'), 1) < ?
          ORDER BY COALESCE(json_extract(ai_rubric, '$.judged_at'), ''), url
          LIMIT ?`,
    args: [primary, version, limit],
  });
  return res.rows;
}
