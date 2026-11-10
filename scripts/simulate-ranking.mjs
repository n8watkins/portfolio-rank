#!/usr/bin/env node
// Offline evaluation of the rating engine: no database, no Gemini.
//
// The roster is the real list (data/feed.json). Real inputs are used when
// given; everything else is simulated (lib/ranking/simulate.mjs):
//   --grades FILE     a grade export (scripts/export-grades.mjs CSV): real
//                     tiers and scores seed those sites; the rest get
//                     simulated grades
//   --votes-log FILE  a judge.mjs pairwise log: its "X beat Y" lines become
//                     real AI votes (--votes-date YYYY-MM-DD, --votes-model M)
//   --days N          simulated days of the daily job (default 56)
//   --out DIR         writes export.json (recompute it with
//                     scripts/recompute-ratings.mjs --from), report.json and report.md
//
// It prints the three boards, how many sites have enough evidence, the
// stability analytics and two sanity checks: seeding by tier puts S above D,
// and a site that improves (its page changes) climbs within N comparisons.
import fs from "node:fs";
import path from "node:path";
import { rankingConfig, PROMPT_VERSION_LEGACY } from "../lib/ranking/config.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import { summarize, summaryMarkdown } from "../lib/ranking/report.mjs";
import { simulate, spearman } from "../lib/ranking/simulate.mjs";
import { inputDigest } from "../lib/ranking/store.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

/** Minimal CSV reader (quoted fields, commas inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** A grade export row as a stored grade (v1 shape: {axis: {score}}). */
export function gradeFromCsv(r) {
  const score = (v) => (v === "" || v == null ? null : { score: Number(v) });
  return {
    tier: r.tier,
    is_portfolio: r.is_portfolio !== "false",
    visual_design: score(r.visual_design),
    five_second_test: score(r.five_second),
    storytelling: score(r.storytelling),
    writing: score(r.writing),
    memorability: score(r.memorability),
    rubric_version: 1,
    model: r.model || null,
  };
}

/** "[n/m] URL beat URL - reason" lines of a judge.mjs pairwise log as AI votes. */
export function votesFromLog(text, { date, model }) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\[\d+\/\d+\](?: \([^)]*\))? (\S+) beat (\S+)/);
    if (!m) continue;
    out.push({
      id: out.length + 1,
      created_at: new Date(Date.parse(`${date}T13:00:00Z`) + out.length * 60000).toISOString(),
      rater_type: "ai",
      rater_id: "ai:flash-lite",
      model,
      prompt_version: PROMPT_VERSION_LEGACY,
      method: "one_on_one",
      shown: null,
      ranking: [[m[1]], [m[2]]],
      outcome: "ranked",
      starred: 0,
      experiment: null,
    });
  }
  return out;
}

const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
const grades = new Map();
if (flag("grades")) for (const r of parseCsv(fs.readFileSync(flag("grades"), "utf8"))) if (r.url && r.tier) grades.set(r.url, gradeFromCsv(r));
const realVotes = flag("votes-log")
  ? votesFromLog(fs.readFileSync(flag("votes-log"), "utf8"), { date: flag("votes-date", "2026-06-19"), model: flag("votes-model", "gemini-3.1-flash-lite") })
  : [];

const urls = [...new Set(feed.map((p) => p.url))];
const sites = urls.map((url) => ({ url, grade: grades.get(url) ?? null }));
const notPortfolio = new Set(sites.filter((s) => s.grade?.is_portfolio === false).map((s) => s.url));
const days = Number(flag("days", "56"));
const config = rankingConfig();
const seed = flag("seed", "offline-2026-11-10");
const startDay = flag("start", "2026-09-14");

const sim = simulate({ sites, prior: realVotes, days, seed, start: startDay });
for (const s of sim.sites) if (notPortfolio.has(s.url)) s.listed = false;
const input = { sites: sim.sites, comparisons: sim.comparisons, resets: sim.resets };
const result = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts });
const summary = summarize({ ...result, comparisons: input.comparisons });

// Accuracy against the hidden truth (only a simulation can measure this).
const seedOnly = recompute({ ...input, comparisons: [], resets: [], aiWeight: config.aiWeight, history: false });
const accuracy = {
  seedOnly: spearman(seedOnly.boards.ai, sim.truth),
  ...Object.fromEntries(Object.entries(result.boards).map(([v, b]) => [v, spearman(b, sim.truth)])),
};

// Sanity 1: with no comparisons, every S site ranks above every D site.
const seedBoard = seedOnly.boards.ai;
const worstS = Math.max(...seedBoard.filter((r) => r.tier === "S").map((r) => r.rank));
const bestD = Math.min(...seedBoard.filter((r) => r.tier === "D").map((r) => r.rank));
const tierOrder = { worstS, bestD, ok: worstS < bestD };

// Sanity 2: a D site whose page changes on day 14 and is now S quality.
const listedD = seedBoard.filter((r) => r.tier === "D");
const target = listedD[Math.floor(listedD.length / 2)].url;
const climb = (reset) => {
  const run = simulate({ sites, prior: realVotes, days, seed, start: startDay, improve: { url: target, day: 14, truth: 2.4 }, reset });
  const n = run.sites.length;
  const first = (share) => run.trajectory.find((t) => t.rank <= Math.ceil(n * share)) ?? null;
  return {
    reset,
    comparisons: run.trajectory.length,
    top10: first(0.1),
    top5: first(0.05),
    final: run.trajectory.at(-1) ?? null,
  };
};
const climbs = [climb(true), climb(false)];

const report = {
  data: {
    roster: urls.length,
    realGrades: [...grades.keys()].filter((u) => urls.includes(u)).length,
    simulatedGrades: sim.simulatedGrades,
    realAiVotes: realVotes.length,
    simulatedComparisons: sim.comparisons.length - realVotes.length,
    byKind: sim.comparisons.reduce((m, c) => ((m[`${c.rater_type}/${c.method}`] = (m[`${c.rater_type}/${c.method}`] ?? 0) + 1), m), {}),
    days,
    digest: inputDigest(input),
  },
  accuracy,
  tierOrder,
  improvedSite: { url: target, changedOnDay: 14, climbs },
  ...summary,
};

const md = [
  `# Offline evaluation (${days} simulated days)`,
  "",
  `Roster ${report.data.roster} (data/feed.json); ${report.data.realGrades} real grades, ${report.data.simulatedGrades} simulated; ${report.data.realAiVotes} real AI votes; ${report.data.simulatedComparisons} simulated comparisons (${Object.entries(report.data.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}).`,
  "",
  `Accuracy (Spearman vs hidden truth): seeds only ${accuracy.seedOnly}; ${Object.entries(accuracy).filter(([k]) => k !== "seedOnly").map(([k, v]) => `${k} ${v}`).join(", ")}.`,
  `Seeding: worst S rank ${worstS}, best D rank ${bestD}: ${tierOrder.ok ? "every S above every D" : "FAILED"}.`,
  ...climbs.map(
    (c) =>
      `Improved site (${c.reset ? "with" : "without"} the uncertainty reset): ${c.comparisons} AI comparisons after the change; top 10% after ${c.top10 ? `${c.top10.comparisons} (day ${c.top10.day})` : "never"}, top 5% after ${c.top5 ? `${c.top5.comparisons} (day ${c.top5.day})` : "never"}; final rank ${c.final?.rank ?? "-"}.`
  ),
  "",
  summaryMarkdown(summary),
].join("\n");

if (flag("out")) {
  fs.mkdirSync(flag("out"), { recursive: true });
  fs.writeFileSync(path.join(flag("out"), "export.json"), JSON.stringify({ format: "portfoliorank-comparisons/1", exported_at: new Date().toISOString(), simulated: true, ...input }));
  fs.writeFileSync(path.join(flag("out"), "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(flag("out"), "report.md"), md);
}
console.log(md);
