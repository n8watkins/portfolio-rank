// How do 3.1 Flash-Lite grades compare with 3.5 Flash-Lite grades of the same
// sites? Every re-grade keeps the old grade in rubric_history
// (pipeline/rubric-history.mjs), so each one is a free pair. This report
// reads the database only (no Gemini, no writes) and prints, and writes to
// the job summary: the number of pairs, exact tier agreement, agreement
// within one tier, the mean absolute difference per axis, and how often
// is_portfolio disagrees. Only pairs graded with the same rubric version
// count. Run weekly by .github/workflows/grade-compare.yml.
//
// Usage: node scripts/grade-compare.mjs [--from MODEL] [--to MODEL]
import fs from "fs";
import path from "path";
import { pipelineDb } from "../pipeline/roster.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { versionOf } from "../pipeline/rubric.mjs";

export const AXES = ["visual_design", "five_second_test", "storytelling", "writing", "memorability", "motion"];
const TIER = { S: 5, A: 4, B: 3, C: 2, D: 1 };

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

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

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

export function compareMarkdown(r, { from = BACKUP_MODEL, to = PRIMARY_MODEL } = {}) {
  const lines = [
    `## Grade comparison: ${from} vs ${to}`,
    "",
    `${r.pairs} site(s) graded by both (each re-grade keeps the old grade).`,
    "",
  ];
  if (!r.pairs) return lines.join("\n");
  lines.push(
    "| Measure | Value |",
    "| --- | ---: |",
    `| Same tier | ${pct(r.exact, r.pairs)} (${r.exact}) |`,
    `| Within one tier | ${pct(r.withinOne, r.pairs)} (${r.withinOne}) |`,
    `| is_portfolio disagrees | ${pct(r.portfolioDisagree, r.pairs)} (${r.portfolioDisagree}) |`,
    "",
    "| Axis | Mean absolute difference (1-5 scale) |",
    "| --- | ---: |",
    ...AXES.map((k) => `| ${k} | ${r.mae[k] == null ? "-" : r.mae[k].toFixed(2)} |`),
    ""
  );
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const opts = { from: flag("from", BACKUP_MODEL), to: flag("to", PRIMARY_MODEL) };
  const db = pipelineDb(path.join(import.meta.dirname, ".."));
  let history = [];
  let current = new Map();
  try {
    history = (
      await db.execute("SELECT url, model, rubric, replaced_by_model FROM rubric_history ORDER BY url, id")
    ).rows.map((r) => ({ url: String(r.url), model: r.model == null ? null : String(r.model), rubric: String(r.rubric), replaced_by_model: r.replaced_by_model == null ? null : String(r.replaced_by_model) }));
    const urls = [...new Set(history.map((h) => h.url))];
    for (let i = 0; i < urls.length; i += 400) {
      const part = urls.slice(i, i + 400);
      const res = await db.execute({
        sql: `SELECT url, ai_rubric FROM portfolios WHERE url IN (${part.map(() => "?").join(",")})`,
        args: part,
      });
      for (const r of res.rows) current.set(String(r.url), r.ai_rubric == null ? null : String(r.ai_rubric));
    }
  } catch (e) {
    if (!/no such table/i.test(String(e?.message))) throw e;
  }
  const md = compareMarkdown(compareGrades(buildPairs(history, current, opts)), opts);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}
