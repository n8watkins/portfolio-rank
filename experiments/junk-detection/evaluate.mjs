// Scores the code rules against the hand labels in labels.json.
// Needs local/all.json (from export.mjs) for the row fields and the duplicate index.
// Usage: node experiments/junk-detection/evaluate.mjs  (writes results.json and results.md)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDupIndex, classify, recommend, urlNotPortfolio } from "./rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const all = JSON.parse(readFileSync(join(here, "local/all.json"), "utf8"));
const sample = JSON.parse(readFileSync(join(here, "sample.json"), "utf8"));
const labels = new Map(JSON.parse(readFileSync(join(here, "labels.json"), "utf8")).map((l) => [l.url, l]));
const byUrl = new Map(all.map((r) => [r.url, r]));
const idx = buildDupIndex(all);

const rows = sample.map((s) => {
  const r = byUrl.get(s.url);
  const l = labels.get(s.url);
  if (!l) throw new Error(`no label for ${s.url}`);
  return { ...s, label: l.label, why: l.reason, ...classify(r, idx) };
});

const pct = (x, y) => (y ? `${((100 * x) / y).toFixed(1)}%` : "n/a");
const sure = rows.filter((r) => r.label !== "UNSURE");
const junkSet = sure.filter((r) => r.label === "JUNK");

function score(name, pred, set = sure) {
  const tp = set.filter((r) => pred(r) && r.label === "JUNK").length;
  const fp = set.filter((r) => pred(r) && r.label === "REAL").length;
  const fn = set.filter((r) => !pred(r) && r.label === "JUNK").length;
  const tn = set.filter((r) => !pred(r) && r.label === "REAL").length;
  return { name, n: set.length, tp, fp, fn, tn, precision: pct(tp, tp + fp), recall: pct(tp, tp + fn), accuracy: pct(tp + tn, set.length) };
}

const RULES = [
  ["(a) template fingerprint", (r) => r.a],
  ["(b) same text on another domain", (r) => r.b],
  ["(c) placeholder name", (r) => r.c],
  ["(d) parked or for sale", (r) => r.d],
  ["(e) under 30 words, no links", (r) => r.e],
  ["(e) with the (f) guard", (r) => r.e && !r.strong],
  ["combined (a-d, plus e unless f)", (r) => r.junk],
];
const all100 = RULES.map(([n, p]) => score(n, p));
const textOnly = RULES.map(([n, p]) => score(n, p, sure.filter((r) => r.evaluable)));

// The AI's is_portfolio=0 verdicts against the hand labels.
const np = rows.filter((r) => r.group === "not_portfolio");
const aiCheck = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"].map((m) => {
  const g = np.filter((r) => r.model === m);
  return { model: m, n: g.length, wrong: g.filter((r) => r.label === "REAL").length, unsure: g.filter((r) => r.label === "UNSURE").length };
});

// Precision over every row in the DB that a rule flags (hit-labels.json, labelled from
// screenshots after the rules ran). This is the number that matters for gating.
const hitLabels = JSON.parse(readFileSync(join(here, "hit-labels.json"), "utf8"));
const dbPrecision = [
  ...["a", "b", "c", "d", "e"].map((k) => [`(${k})`, (h) => h.rules.includes(k)]),
  ["(e) with the (f) guard", (h) => h.rules.includes("e") && !h.strong],
  ["combined", (h) => /[abcd]/.test(h.rules) || (h.rules.includes("e") && !h.strong)],
].map(([name, pred]) => {
  const hits = hitLabels.filter(pred);
  const junk = hits.filter((h) => h.label === "JUNK").length;
  const real = hits.filter((h) => h.label === "REAL").length;
  const unsure = hits.filter((h) => h.label === "UNSURE").length;
  return { name, hits: hits.length, junk, real, unsure, precision: pct(junk, junk + real), falsePositives: hits.filter((h) => h.label === "REAL").map((h) => h.url) };
});

// Extra URL-only rule suggested by the sample's misses (tuned on this sample, so optimistic):
// the listed URL is a code host repo, a link-in-bio service, or an admin/login path.
const urlRule = (r) => urlNotPortfolio(r.url);
const withUrl = [score("(u) URL is a repo, link hub or admin page", urlRule), score("combined plus (u)", (r) => r.junk || urlRule(r))];
const urlDbHits = all.filter((r) => urlRule(r)).map((r) => r.url);

// The recommended narrowed set, on the sample and over the whole DB.
const rec = new Map(all.map((r) => [r.url, recommend(r, idx)]));
const recSample = score("recommended (strict a, c, d plus u)", (r) => rec.get(r.url).junk);
const hitLabel = new Map(hitLabels.map((h) => [h.url, h.label]));
const sampleLabel = new Map(rows.map((r) => [r.url, r.label]));
const recDb = all
  .filter((r) => rec.get(r.url).junk || rec.get(r.url).review)
  .map((r) => ({ url: r.url, action: rec.get(r.url).junk ? "junk" : "review", label: hitLabel.get(r.url) ?? sampleLabel.get(r.url) ?? "not labelled" }));

const out = {
  recSample,
  recDb,
  dbPrecision,
  withUrl,
  urlDbHits,
  counts: {
    sample: rows.length,
    labels: Object.fromEntries(["REAL", "JUNK", "UNSURE"].map((k) => [k, rows.filter((r) => r.label === k).length])),
    evaluable: rows.filter((r) => r.evaluable).length,
    junk_without_text: junkSet.filter((r) => !r.evaluable).length,
  },
  all100,
  textOnly,
  aiCheck,
  falsePositives: sure.filter((r) => r.junk && r.label === "REAL").map((r) => ({ url: r.url, rules: "abcde".split("").filter((k) => r[k]).join(""), why: r.why })),
  falseNegatives: sure.filter((r) => !r.junk && r.label === "JUNK").map((r) => ({ url: r.url, evaluable: r.evaluable, why: r.why })),
  rows: rows.map(({ id, url, group, model, label, a, b, c, d, e, strong, junk, evaluable }) => ({ id, url, group, model, label, a, b, c, d, e, strong, junk, evaluable })),
};
writeFileSync(join(here, "results.json"), JSON.stringify(out, null, 1) + "\n");

const table = (list) =>
  ["| Rule | n | TP | FP | FN | TN | Precision | Recall | Accuracy |", "|---|---|---|---|---|---|---|---|---|", ...list.map((s) => `| ${s.name} | ${s.n} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${s.precision} | ${s.recall} | ${s.accuracy} |`)].join("\n");
const md = [
  "# Results (generated by evaluate.mjs)",
  "",
  `Labels: ${JSON.stringify(out.counts.labels)}; rows with stored text or facts: ${out.counts.evaluable} of ${rows.length}; junk with nothing stored: ${out.counts.junk_without_text}.`,
  "",
  "## All labelled rows (UNSURE left out)",
  "",
  table(all100),
  "",
  "## Only rows with stored page text or facts",
  "",
  table(textOnly),
  "",
  "## Precision over every flagged row in the whole DB",
  "",
  "| Rule | Rows flagged | Junk | Real | Unsure | Precision |",
  "|---|---|---|---|---|---|",
  ...dbPrecision.map((p) => `| ${p.name} | ${p.hits} | ${p.junk} | ${p.real} | ${p.unsure} | ${p.precision} |`),
  "",
  "## Extra URL rule (tuned on this sample)",
  "",
  table(withUrl),
  "",
  `Rows in the whole DB the URL rule flags (${urlDbHits.length}): ${urlDbHits.join(", ")}`,
  "",
  "## Recommended narrowed set",
  "",
  table([recSample]),
  "",
  `Rows in the whole DB it acts on (${recDb.length}):`,
  "",
  ...recDb.map((r) => `- ${r.action}: ${r.url} (label: ${r.label})`),
  "",
  "## False positives (real sites called junk)",
  "",
  ...(out.falsePositives.length ? out.falsePositives.map((r) => `- ${r.url} (rules ${r.rules}): ${r.why}`) : ["- none"]),
  "",
  "## False negatives (junk missed)",
  "",
  ...out.falseNegatives.map((r) => `- ${r.url}${r.evaluable ? "" : " (no stored text)"}: ${r.why}`),
  "",
  "## AI is_portfolio=0 verdicts that look wrong",
  "",
  ...aiCheck.map((a) => `- ${a.model}: ${a.wrong} of ${a.n} graded not-a-portfolio are real portfolios (${pct(a.wrong, a.n)}); ${a.unsure} unsure.`),
  "",
].join("\n");
writeFileSync(join(here, "results.md"), md);
console.log(md);
