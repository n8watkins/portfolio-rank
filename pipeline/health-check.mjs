#!/usr/bin/env node
// The nightly cleanup job (.github/workflows/health.yml; every night since
// 2026-11-16, weekly before). Free: no Gemini.
//
//   1. roster sync: rows no longer in data/feed.json are marked delisted
//   2. health check: every listed site is checked and its state advanced
//      (pipeline/health.mjs), except the sites on the not-working ladder,
//      which the hourly re-check looks at when they are due
//      (pipeline/not-working.mjs, pipeline/recheck.mjs)
//   3. --exclusions: planned once a week (exclusions.mjs EXPORT_EVERY_DAYS,
//      weeklyExport): sites in the temporary pool for 90 days go to the
//      archive, data/excluded.json, and out of data/feed.json, with removals
//      decided in the review queue (the workflow opens the bot pull request);
//      archived entries due for their check are checked again, and one that
//      passes leaves the archive (recorded in data/additions.json so the list
//      takes it back); the plan is applied again every night until it lands
//      on main.
//
// Rows delisted for 30+ days are purged by pipeline/purge-delisted.mjs.
//
// --dry-run checks every site the same way and writes nothing: no roster
// sync, no health state, no files, no alert. It prints what would change.
//
// Usage:
//   node pipeline/health-check.mjs [--limit N] [--concurrency C] [--no-browser]
//                                  [--exclusions] [--dry-run]
// Writes a Markdown report to GITHUB_STEP_SUMMARY when set. Exits 1 when the
// run looks broken (most sites failing at once) so the workflow files an issue.
import fs from "fs";
import path from "path";
import { healthSummary, runHealthCheck } from "./health.mjs";
import { ARCHIVE_EVERY_DAYS, ARCHIVE_FIRST_DAYS, EXPORT_EVERY_DAYS, readJson, weeklyExport } from "./exclusions.mjs";
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

// A dry run writes nothing at all, the roster sync included (it reads the list as it stands).
if (DRY) {
  console.log("dry run: nothing is written (no roster sync, no health state, no files, no alert)");
} else {
  const roster = await syncRoster(db, feed);
  console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
}

// The browser second opinion (single-page apps, JavaScript redirects, cold starts).
const renderer = args.includes("--no-browser") ? null : createRenderer();
const render = renderer?.render;

let exitCode = 0;
try {
  const result = await runHealthCheck({ db, feed, render, concurrency: CONCURRENCY, limit: LIMIT, dryRun: DRY });
  report(healthSummary(result));
  if (result.aborted) {
    console.error(`::error::${result.message}`);
    exitCode = 1;
  }

  if (!result.aborted && args.includes("--exclusions")) {
    const excludedPath = path.join(ROOT, "data", "excluded.json");
    // Planned once a week and applied every night until it lands on main (./exclusions.mjs weeklyExport):
    // the workflow rewrites its pull request from main whenever a data file changes.
    const additionsPath = path.join(ROOT, "data", "additions.json");
    const additions = readJson(additionsPath, []);
    const ex = await weeklyExport({ db, excluded: readJson(excludedPath, []), feed, additions, render, dryRun: DRY, log: console.log });
    if (ex.files && !DRY) {
      fs.writeFileSync(excludedPath, `${JSON.stringify(ex.files.excluded, null, 2)}\n`);
      if (ex.plan.added.length) fs.writeFileSync(path.join(ROOT, "data", "feed.json"), `${JSON.stringify(ex.files.feed, null, 2)}\n`);
      // Sites back from the archive: recorded so the next sync lists them again (exclusions.mjs applyExport).
      if (ex.files.additions && ex.files.additions.length !== additions.length) fs.writeFileSync(additionsPath, `${JSON.stringify(ex.files.additions, null, 2)}\n`);
    }
    const p = ex.plan;
    const verb = (now, would) => (DRY ? would : now);
    report(
      "### Excluded\n\n" +
        (ex.landed ? "Last week's export has landed on main.\n\n" : "") +
        (!p
          ? `Nothing to export${ex.planned ? "" : `; a new export is planned once every ${EXPORT_EVERY_DAYS}+ days`}.\n`
          : `${ex.planned ? "Planned tonight" : "Planned earlier and not on main yet, applied again"}: ${p.added.length} site(s) in the temporary pool for ${LEAVE_AFTER_DAYS}+ days or removed by a review decision ${verb("added to", "would be added to")} data/excluded.json (archived sites are the "down" and "dead" kinds); ${p.back.length} archived site(s) passed the full check and ${verb("leave", "would leave")} it${p.back.length ? ` (${p.back.join(", ")})` : ""}; ${p.still.length} still failing or unknown, checked again on days ${ARCHIVE_FIRST_DAYS.join(", ")} after archiving and then every ${ARCHIVE_EVERY_DAYS} days.\n`) +
        (ex.held.length ? `\nHidden or down but still on the list: ${ex.held.map((h) => `${h.url} (${h.why})`).join("; ")}.\n` : "")
    );
  }
} finally {
  await renderer?.close();
}
if (!process.env.GITHUB_STEP_SUMMARY) console.log(`\n${summaryOut.join("\n")}`);
process.exit(exitCode);
