// Prewarm the PSI (Lighthouse) + inspect (polish) caches for graded S/A/B sites
// by hitting the prod API endpoints, which cache results to Turso (shared with
// the pipeline). This is what makes the daily voting robot's metrics-enriched
// comparisons actually have metrics — otherwise the cache is only filled lazily
// by real visitors. Paced; safe to re-run (endpoints serve cache when fresh).
// Exits 1 when more than half the lookups fail (or all of them), naming the most
// common error, so a missing key or a spent quota turns the job red.
//
// Usage: node scripts/prewarm-metrics.mjs [--limit=N]
import { createClient } from "@libsql/client";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { runPrewarm } from "./lib/prewarm.mjs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PROD = process.env.PROD_BASE_URL || "https://portfoliorank.n8builds.dev";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 150;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// S/A/B sites missing fresh metrics are prioritized: order by url and let the
// endpoint's own cache short-circuit already-warm ones cheaply.
const rows = (
  await db.execute("SELECT url FROM portfolios WHERE status='live' ORDER BY url")
).rows.slice(0, LIMIT);

console.log(`prewarming PSI + inspect for ${rows.length} site(s) via ${PROD}`);
const { exitCode, summary, verdict } = await runPrewarm({
  urls: rows.map((r) => String(r.url)),
  base: PROD,
  pauseMs: Number(process.env.PREWARM_PAUSE_MS ?? 1200), // gentle pacing
});
console.log(`\n${summary}`);
// The Actions job summary shows the table on the run page.
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (exitCode !== 0) console.error(`::error::${verdict}`);
process.exit(exitCode);
