#!/usr/bin/env node
// Helpers for .github/workflows/staging-capture.yml (DEPLOY.md "Staging"): an
// on-demand capture and free checks on a small sample, run against staging's
// database, so a changed pipeline step can be proved once before a release.
//
//   node scripts/staging-capture.mjs guard            refuse unless the database names staging and nothing can reach production
//   node scripts/staging-capture.mjs summary <log>    the run summary (markdown) from pipeline/capture.mjs's output
//
// The guard reads STAGING_TURSO_DATABASE_URL and the environment; it connects
// to nothing.

import { readFileSync } from "node:fs";

/** Why a run must not start, or null. `env` is process.env. Exported for the tests. */
export function guardRefusal(env) {
  const url = env.STAGING_TURSO_DATABASE_URL;
  if (!url) return "STAGING_TURSO_DATABASE_URL is not set";
  let host;
  try {
    host = (new URL(url).host || String(url)).toLowerCase();
  } catch {
    host = String(url).toLowerCase();
  }
  if (!/staging/.test(host)) return `the database ${host} does not name a staging database`;
  // The pipeline connects to TURSO_DATABASE_URL (pipeline/roster.mjs pipelineDb): it must be staging's, and set.
  if (env.TURSO_DATABASE_URL !== url) return "TURSO_DATABASE_URL is not staging's database";
  // Staging shares production's screenshots bucket: a run with R2 credentials would overwrite production's screenshots.
  for (const name of Object.keys(env)) if (/^R2_/.test(name) && env[name]) return `${name} is set: a staging run must keep screenshots on disk`;
  if (env.GEMINI_API_KEY) return "GEMINI_API_KEY is set: this run makes no AI request";
  return null;
}

const LINE = /^\[(\d+)\/(\d+)\] (\S+) \u2014 (.*) \((\d+(?:\.\d+)?)s\)$/;

/** The sites in pipeline/capture.mjs's output: `[i/n] url, then a dash, then result (3.2s)`. Exported for the tests. */
export function parseCaptureLog(text) {
  const sites = [];
  for (const line of String(text).split("\n")) {
    const m = LINE.exec(line.trim());
    if (m) sites.push({ url: m[3], result: m[4], seconds: Number(m[5]), captured: m[4].startsWith("live") });
  }
  return sites;
}

/** The run summary as markdown. Exported for the tests. */
export function summary(sites, { requested } = {}) {
  const captured = sites.filter((s) => s.captured);
  const failed = sites.filter((s) => !s.captured);
  const total = sites.reduce((n, s) => n + s.seconds, 0);
  const lines = [
    "## Staging capture",
    "",
    `- Sites asked for: ${requested ?? "?"}`,
    `- Sites captured: ${captured.length} of ${sites.length} tried`,
    `- Failures: ${failed.length}`,
    `- Seconds per site: ${sites.length ? (total / sites.length).toFixed(1) : "n/a"} on average (${sites.length ? Math.max(...sites.map((s) => s.seconds)).toFixed(1) : "n/a"} slowest)`,
  ];
  if (!sites.length) lines.push("", "No site was captured: nothing was due or the run stopped early. Read the step log.");
  if (failed.length) {
    lines.push("", "| Site | Reason | Seconds |", "| --- | --- | --- |");
    for (const s of failed) lines.push(`| ${s.url} | ${s.result.replace(/\|/g, "\\|")} | ${s.seconds.toFixed(1)} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, file] = process.argv.slice(2);
  if (command === "guard") {
    const why = guardRefusal(process.env);
    if (why) {
      console.error(`::error::refusing to run the staging capture: ${why}`);
      process.exit(1);
    }
    console.log("guard ok: the database names staging, no R2_*, no production database, no Gemini key");
  } else if (command === "summary" && file) {
    process.stdout.write(summary(parseCaptureLog(readFileSync(file, "utf8")), { requested: process.env.SITES }));
  } else {
    console.error("usage: staging-capture.mjs guard | summary <capture log>");
    process.exit(2);
  }
}
