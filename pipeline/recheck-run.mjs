#!/usr/bin/env node
// The hourly re-check of the not-working pool (.github/workflows/recheck.yml;
// pipeline/recheck.mjs). Free: no Gemini, no email.
//
// Usage: node pipeline/recheck-run.mjs [--no-browser] [--controls N]
// Writes a Markdown report to GITHUB_STEP_SUMMARY when set. Exits 1 when the
// run looks broken (its browser never started, or too few control sites
// loaded) so the workflow files an issue; nothing is recorded then.
import fs from "node:fs";
import path from "node:path";
import { pipelineDb } from "./roster.mjs";
import { createRenderer } from "./render.mjs";
import { CONTROL_SITES, recheckSummary, runRecheck } from "./recheck.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const db = pipelineDb(path.join(import.meta.dirname, ".."));
const renderer = args.includes("--no-browser") ? null : createRenderer();
let exitCode = 0;
try {
  const s = await runRecheck({ db, render: renderer?.render, controls: Number(flag("controls", String(CONTROL_SITES))) });
  const md = recheckSummary(s);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(`\n${md}`);
  if (s.aborted) {
    console.error(`::error::${s.message}`);
    exitCode = 1;
  }
} finally {
  await renderer?.close();
}
process.exit(exitCode);
