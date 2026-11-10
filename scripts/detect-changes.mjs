#!/usr/bin/env node
// The nightly fingerprint check (sync-upstream.yml, after capture): records
// each captured site's page fingerprint and, when it changed since the last
// capture, an uncertainty reset in rating_resets (lib/ranking/store.mjs).
// The end-of-day run grades sites whose reset is newer than their grade
// ("Grade changed sites", pipeline/night.mjs) the same night. Free: no
// Gemini.
//
//   node scripts/detect-changes.mjs
import fs from "node:fs";
import path from "node:path";
import { pipelineDb } from "../pipeline/roster.mjs";
import { detectPageChanges, ensureRankingSchema } from "../lib/ranking/store.mjs";

const db = pipelineDb(path.join(import.meta.dirname, ".."));
await ensureRankingSchema(db);
const resets = await detectPageChanges(db);
const line = `page changes: ${resets} site(s) changed since their last capture`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
