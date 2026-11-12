// Prewarm the PSI (Lighthouse) + inspect (polish) caches for graded S/A/B sites
// whose results are due by the check rule (lib/freshness.mjs: never measured,
// the site changed, the admin asked, or past the maximum age) by hitting the
// prod API endpoints, which cache results to Turso (shared with
// the pipeline). This is what makes the daily voting robot's metrics-enriched
// comparisons actually have metrics; otherwise the cache is only filled lazily
// by real visitors. Paced; safe to re-run (endpoints serve cache when fresh).
// Exits 1 when more than half the lookups fail (or all of them), naming the most
// common error, so a missing key or a spent quota turns the job red.
//
// Usage: node scripts/prewarm-metrics.mjs [--limit=N]
import { appendFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { runPrewarm } from "./lib/prewarm.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb, syncRoster } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema, lighthouseDue } from "../lib/freshness.mjs";
import feed from "../data/feed.json" with { type: "json" };

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PROD = process.env.PROD_BASE_URL || "https://portfoliorank.n8builds.dev";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 150;

const db = pipelineDb(path.join(import.meta.dirname, ".."));
await ensureRosterSchema(db);
await ensureFreshnessSchema(db);
// Only sites on the current list (data/feed.json) can be scored: rows that
// left it are marked delisted and skipped.
await syncRoster(db, feed);

// Listed, not confirmed down, graded S/A/B (the voting robot's pool), and
// with a Lighthouse or polish result that is due: never measured first, then
// sites that changed or the admin re-measured, then the oldest.
const urls = await lighthouseDue(db, { limit: LIMIT, active: ACTIVE });

console.log(`prewarming PSI + inspect for ${urls.length} S/A/B site(s) whose metrics are due via ${PROD}`);
const { exitCode, summary, verdict } = await runPrewarm({
  urls,
  base: PROD,
  pauseMs: Number(process.env.PREWARM_PAUSE_MS ?? 1200), // gentle pacing
});
console.log(`\n${summary}`);
// The Actions job summary shows the table on the run page.
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (exitCode !== 0) console.error(`::error::${verdict}`);
process.exit(exitCode);
