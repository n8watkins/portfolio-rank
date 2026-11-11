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
import { AXES, buildPairs, compareGrades } from "../pipeline/grade-pairs.mjs";

export { AXES, buildPairs, compareGrades };

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

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
