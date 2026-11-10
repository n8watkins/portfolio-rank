#!/usr/bin/env node
// The weekly cleanup job (.github/workflows/health.yml). Free: no Gemini.
//
//   1. roster sync: rows no longer in data/feed.json are marked delisted
//   2. health check: every listed site is checked and its state advanced
//      (pipeline/health.mjs: live -> suspect -> down)
//   3. --exclusions: confirmed-down sites go into data/excluded.json and out
//      of data/feed.json (the workflow opens the bot pull request)
//
// Rows delisted for 30+ days are purged by pipeline/purge-delisted.mjs.
//
// Usage:
//   node pipeline/health-check.mjs [--limit N] [--concurrency C] [--no-browser]
//                                  [--exclusions] [--dry-run]
// Writes a Markdown report to GITHUB_STEP_SUMMARY when set. Exits 1 when the
// run looks broken (most sites failing at once) so the workflow files an issue.
import fs from "fs";
import path from "path";
import { readRenderedPage, UA } from "./gate.mjs";
import { healthSummary, runHealthCheck } from "./health.mjs";
import { planExclusions, readJson } from "./exclusions.mjs";
import { loadFeed, pipelineDb, syncRoster } from "./roster.mjs";

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
let browser = null;
let render;
if (!args.includes("--no-browser")) {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  render = async (url) => {
    // Certificate errors stay errors: a visitor would see a warning page.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    try {
      const page = await ctx.newPage();
      const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return {
        status: res?.status() ?? 0,
        finalUrl: page.url(),
        title: await page.title().catch(() => ""),
        ...(await page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false }))),
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  };
}

let exitCode = 0;
try {
  const result = await runHealthCheck({ db, feed, render, concurrency: CONCURRENCY, limit: LIMIT });
  report(healthSummary(result));
  if (result.aborted) {
    console.error(`::error::${result.message}`);
    exitCode = 1;
  }

  if (!result.aborted && args.includes("--exclusions")) {
    const excludedPath = path.join(ROOT, "data", "excluded.json");
    const plan = await planExclusions({ db, excluded: readJson(excludedPath, []), feed });
    if (plan.added.length && !DRY) {
      fs.writeFileSync(excludedPath, `${JSON.stringify(plan.excluded, null, 2)}\n`);
      fs.writeFileSync(path.join(ROOT, "data", "feed.json"), `${JSON.stringify(plan.feed, null, 2)}\n`);
    }
    report(
      plan.added.length
        ? `### Excluded\n\n${plan.added.length} confirmed-down site(s) ${DRY ? "would be" : "were"} added to data/excluded.json.\n`
        : "### Excluded\n\nNo new exclusions.\n"
    );
  }
} finally {
  await browser?.close();
}
if (!process.env.GITHUB_STEP_SUMMARY) console.log(`\n${summaryOut.join("\n")}`);
process.exit(exitCode);
