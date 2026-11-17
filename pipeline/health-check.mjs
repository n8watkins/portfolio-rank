#!/usr/bin/env node
// The nightly cleanup job (.github/workflows/health.yml; every night since
// 2026-11-16, weekly before). Free: no Gemini.
//
//   1. roster sync: rows no longer in data/feed.json are marked delisted
//   2. health check: every listed site is checked and its state advanced
//      (pipeline/health.mjs), except the sites on the not-working ladder,
//      which the hourly re-check looks at when they are due
//      (pipeline/not-working.mjs, pipeline/recheck.mjs)
//   3. --exclusions, once a week (exclusions.mjs EXPORT_EVERY_DAYS):
//      confirmed-down sites and sites not working for 90 days go into
//      data/excluded.json and out of data/feed.json (the workflow opens the
//      bot pull request), and removed entries due for their check are
//      checked again. --exclusions=always exports on every run.
//
// Rows delisted for 30+ days are purged by pipeline/purge-delisted.mjs.
//
// Usage:
//   node pipeline/health-check.mjs [--limit N] [--concurrency C] [--no-browser]
//                                  [--exclusions | --exclusions=always] [--dry-run]
// Writes a Markdown report to GITHUB_STEP_SUMMARY when set. Exits 1 when the
// run looks broken (most sites failing at once) so the workflow files an issue.
import fs from "fs";
import path from "path";
import { healthSummary, runHealthCheck } from "./health.mjs";
import { DEAD_RECHECK_DAYS, DOWN_RECHECK_DAYS, EXPORT_EVERY_DAYS, exportDue, markExported, planDeadRecheck, planExclusions, readJson } from "./exclusions.mjs";
import { loadFeed, pipelineDb, syncRoster } from "./roster.mjs";
import { createRenderer } from "./render.mjs";
import { LEAVE_AFTER_DAYS } from "./not-working.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Number(flag("limit", "0")) || Infinity;
const CONCURRENCY = Number(flag("concurrency", "8"));
const DRY = args.includes("--dry-run");

const summaryOut = [];
const report = (md) => {
  summaryOut.push(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
};

const db = pipelineDb(ROOT);
const feed = await loadFeed(ROOT);

const roster = await syncRoster(db, feed);
console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);

// The browser second opinion (single-page apps, JavaScript redirects, cold starts).
const renderer = args.includes("--no-browser") ? null : createRenderer();
const render = renderer?.render;

let exitCode = 0;
try {
  const result = await runHealthCheck({ db, feed, render, concurrency: CONCURRENCY, limit: LIMIT });
  report(healthSummary(result));
  if (result.aborted) {
    console.error(`::error::${result.message}`);
    exitCode = 1;
  }

  const exportAsked = args.includes("--exclusions") || args.includes("--exclusions=always");
  const exportNow = exportAsked && (args.includes("--exclusions=always") || (await exportDue(db)));
  if (!result.aborted && exportAsked && !exportNow) {
    report(`### Excluded\n\nThe export to data/excluded.json runs once every ${EXPORT_EVERY_DAYS}+ days; not tonight.\n`);
  }
  if (!result.aborted && exportNow) {
    const excludedPath = path.join(ROOT, "data", "excluded.json");
    const plan = await planExclusions({ db, excluded: readJson(excludedPath, []), feed });
    // Dead (every few months) and down (monthly) entries due for their check: back on the list if they
    // pass the same full check (with the browser) that removed them.
    const dead = await planDeadRecheck({ excluded: plan.excluded, render });
    const changed = plan.added.length || dead.back.length || dead.still.length;
    if (changed && !DRY) {
      fs.writeFileSync(excludedPath, `${JSON.stringify(dead.excluded, null, 2)}\n`);
      if (plan.added.length) fs.writeFileSync(path.join(ROOT, "data", "feed.json"), `${JSON.stringify(plan.feed, null, 2)}\n`);
    }
    if (!DRY) await markExported(db);
    report(
      (plan.added.length
        ? `### Excluded\n\n${plan.added.length} site(s) confirmed down or not working for ${LEAVE_AFTER_DAYS}+ days ${DRY ? "would be" : "were"} added to data/excluded.json.\n`
        : "### Excluded\n\nNo new exclusions.\n") +
        (plan.held.length ? `\nHidden or down but still on the list: ${plan.held.map((h) => `${h.url} (${h.why})`).join("; ")}.\n` : "") +
        (dead.back.length || dead.still.length
          ? `\n${dead.back.length} removed site(s) passed the full check again and ${DRY ? "would leave" : "left"} the exclusion list${dead.back.length ? ` (${dead.back.join(", ")})` : ""}; ${dead.still.length} still failing or unknown, checked again in ${DOWN_RECHECK_DAYS} days (down) or ${DEAD_RECHECK_DAYS} days (dead).\n`
          : "")
    );
  }
} finally {
  await renderer?.close();
}
if (!process.env.GITHUB_STEP_SUMMARY) console.log(`\n${summaryOut.join("\n")}`);
process.exit(exitCode);
