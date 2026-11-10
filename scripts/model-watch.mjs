// Model watch by hand (the Worker runs it every Monday; AUTOMATION.md
// "Model watch"). Reads Google's model list (needs GEMINI_API_KEY; a
// metadata call, no generate quota), the deprecations page and the release
// notes, compares them with the last snapshot and prints the report.
//
// Usage:
//   pass-env run -- node scripts/model-watch.mjs            store the run and record the alerts
//   pass-env run -- node scripts/model-watch.mjs --dry-run  print only; writes nothing
// The database is pipelineDb's: Turso with TURSO_*, else LOCAL_DB_FILE or
// data/portfoliorank.db. Email stays off (pipeline/alerts.mjs emailSender, not wired yet).
import path from "path";
import { fileURLToPath } from "url";
import { pipelineDb } from "../pipeline/roster.mjs";
import { reconcileAlerts } from "../pipeline/alerts.mjs";
import { isModelWatchAlert, runModelWatch } from "../pipeline/model-watch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const db = pipelineDb(root);
const r = await runModelWatch({
  db,
  apiKey: process.env.GEMINI_API_KEY,
  dryRun,
  log: (text) => console.log(text),
  reconcile: (conditions) => reconcileAlerts(db, { conditions, scope: isModelWatchAlert, log: (line) => console.log(line) }),
});
console.log(`\nstatus ${r.status}, ${r.report.changes} change(s)${dryRun ? " (dry run: nothing stored)" : ""}`);
for (const c of r.conditions) console.log(`alert ${c.key}: ${c.title}`);
if (r.status === "failed") process.exitCode = 1;
