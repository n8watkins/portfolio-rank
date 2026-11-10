#!/usr/bin/env node
// Rebuilds the three leaderboards (People, AI, Merged) from the stored
// comparisons, from scratch, with the OpenSkill engine (RANKING.md).
//
//   node scripts/recompute-ratings.mjs                 database -> site_ratings, rank_history
//   node scripts/recompute-ratings.mjs --read-only     database, nothing written (summary only)
//   node scripts/recompute-ratings.mjs --from FILE     an export instead of the database (anyone can do this)
//   node scripts/recompute-ratings.mjs --export FILE   also write the input as an export
//   options: --full (rewrite every weekly snapshot), --report FILE (summary as JSON), --top N
//
// With the database (Turso when TURSO_DATABASE_URL is set, else the local
// file), a normal run first mirrors the vote log into comparisons
// (lib/ranking/store.mjs syncVotes) and runs the redesign hook over the
// captured sites (detectPageChanges); both are idempotent. Nothing the live
// site reads is changed: the current leaderboard keeps reading `ratings`.
import fs from "node:fs";
import path from "node:path";
import { rankingConfig } from "../lib/ranking/config.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import { summarize, summaryMarkdown } from "../lib/ranking/report.mjs";
import { detectPageChanges, ensureRankingSchema, inputDigest, loadInput, syncVotes, writeResults } from "../lib/ranking/store.mjs";

export const EXPORT_FORMAT = "portfoliorank-comparisons/1";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const config = rankingConfig();
const top = Number(flag("top", "20"));
let input;
let db = null;
if (flag("from")) {
  const data = JSON.parse(fs.readFileSync(flag("from"), "utf8"));
  if (data.format !== EXPORT_FORMAT) throw new Error(`--from: expected format ${EXPORT_FORMAT}, got ${data.format}`);
  input = { sites: data.sites, comparisons: data.comparisons, resets: data.resets ?? [] };
} else {
  const { pipelineDb } = await import("../pipeline/roster.mjs");
  db = pipelineDb(ROOT);
  if (has("read-only")) {
    input = await loadInput(db, { readOnly: true });
  } else {
    await ensureRankingSchema(db);
    const synced = await syncVotes(db);
    const resets = await detectPageChanges(db);
    console.log(`votes mirrored: ${synced.imported} added or updated, ${synced.removed} removed; page changes: ${resets} new reset(s)`);
    input = await loadInput(db);
  }
}

const digest = inputDigest(input);
if (flag("export")) {
  fs.writeFileSync(
    flag("export"),
    JSON.stringify({ format: EXPORT_FORMAT, exported_at: new Date().toISOString(), digest, ...input })
  );
  console.log(`export written to ${flag("export")}`);
}

const started = Date.now();
const result = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts });
const summary = summarize({ ...result, comparisons: input.comparisons, top });
summary.digest = digest;
summary.ms = Date.now() - started;

if (db && !has("read-only")) {
  const { runId, historyWeeks } = await writeResults(db, { ...result, digest, config, summary: { views: Object.fromEntries(Object.entries(summary.views).map(([k, v]) => [k, { ...v, top: undefined }])) }, full: has("full") });
  console.log(`run ${runId}: site_ratings rewritten, ${historyWeeks} week(s) of rank history written`);
}
if (flag("report")) fs.writeFileSync(flag("report"), JSON.stringify(summary, null, 2));

const md = `# Leaderboards (ranking v2)\n\nInput digest ${digest.slice(0, 16)}, ${input.comparisons.length} comparison(s), ${input.sites.length} site(s), recomputed in ${summary.ms} ms.\n\n${summaryMarkdown(summary, { top })}`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else console.log(md);
