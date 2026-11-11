// Pairs of grades of the same site by two models, and how they compare:
// shared by the weekly report (scripts/grade-compare.mjs) and the content
// engine's "3.1 vs 3.5" fact builder (pipeline/content/facts.mjs). Pure, no
// database or file access, so the Worker can bundle it.
import { BACKUP_MODEL, PRIMARY_MODEL } from "./gemini.mjs";
import { versionOf } from "./rubric.mjs";

export const AXES = ["visual_design", "five_second_test", "storytelling", "writing", "memorability", "motion"];
export const TIER = { S: 5, A: 4, B: 3, C: 2, D: 1 };

const parse = (json) => {
  try {
    const r = JSON.parse(String(json));
    return r && r.tier ? r : null;
  } catch {
    return null;
  }
};

/**
 * Pairs (old grade by `from`, the grade by `to` that replaced it) from
 * rubric_history rows (ordered by url, id) and the current grades.
 */
export function buildPairs(history, current, { from = BACKUP_MODEL, to = PRIMARY_MODEL } = {}) {
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.model !== from || h.replaced_by_model !== to) continue;
    const next = history[i + 1]?.url === h.url ? history[i + 1].rubric : current.get(h.url);
    const a = parse(h.rubric);
    const b = parse(next);
    // Only same-rubric pairs measure the model: a v1 grade against a v2 grade
    // differs by rubric too (pipeline/rubric.mjs RUBRIC_VERSION).
    if (a && b && b.model === to && versionOf(a) === versionOf(b)) pairs.push({ url: h.url, a, b });
  }
  return pairs;
}

/** The comparison numbers for a list of pairs. */
export function compareGrades(pairs) {
  const n = pairs.length;
  let exact = 0;
  let withinOne = 0;
  let portfolioDisagree = 0;
  const axis = Object.fromEntries(AXES.map((k) => [k, { sum: 0, n: 0 }]));
  for (const { a, b } of pairs) {
    const ta = TIER[a.tier];
    const tb = TIER[b.tier];
    if (ta && tb) {
      if (ta === tb) exact++;
      if (Math.abs(ta - tb) <= 1) withinOne++;
    }
    if (Boolean(a.is_portfolio) !== Boolean(b.is_portfolio)) portfolioDisagree++;
    for (const k of AXES) {
      const sa = a[k]?.score;
      const sb = b[k]?.score;
      if (typeof sa === "number" && typeof sb === "number") {
        axis[k].sum += Math.abs(sa - sb);
        axis[k].n++;
      }
    }
  }
  return {
    pairs: n,
    exact,
    withinOne,
    portfolioDisagree,
    mae: Object.fromEntries(AXES.map((k) => [k, axis[k].n ? axis[k].sum / axis[k].n : null])),
  };
}

