// Prewarm the PSI (Lighthouse) + inspect (polish) results for every listed
// portfolio the library takes (not only Gemini's S/A/B: check points, the seed
// of every ELO, include Lighthouse, and Gemini's letter no longer decides
// tiers). Lighthouse is measured here, directly: this job calls Google
// PageSpeed from its own runner (four runs a site, two phone and two desktop,
// averaged per device; lib/psi-job.mjs) and writes the results to Turso with
// the credentials it already has. It is the only thing that measures the
// stored two-run results: the app only reads them (app/api/psi), and the app's
// own secrets (AUTH_SECRET) are never given to this job. The polish check goes
// through the prod site's /api/inspect, which caches it. Paced; safe to
// re-run. Exits 1 when more than half the lookups fail (or all of them), or
// when PageSpeed refuses the day's quota (it stops there), naming the cause.
//
// Needs the PSI_API_KEY secret (a Google PageSpeed key); see the message below.
//
// Usage: node scripts/prewarm-metrics.mjs [--limit=N]
import { appendFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { PREWARM_LIMIT, prewarmQueue, runPrewarm } from "./lib/prewarm.mjs";
import { DEFAULT_RUN_GAP_MS, PREWARM_CONCURRENCY, RATE_LIMIT_WAITS_MS } from "../lib/psi-pacing.mjs";
import { runPsiCall } from "../lib/psi-core.mjs";
import { measureAndStore } from "../lib/psi-job.mjs";
import { ACTIVE, ensureRosterSchema, pipelineDb, syncRoster } from "../pipeline/roster.mjs";
import feed from "../data/feed.json" with { type: "json" };

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

if (!process.env.PSI_API_KEY) {
  console.error(
    "::error::PSI_API_KEY is not set, so Lighthouse cannot be measured. Add a repository Actions secret named PSI_API_KEY (GitHub repository > Settings > Secrets and variables > Actions > New repository secret) holding the Google PageSpeed API key; the prewarm step reads it from there."
  );
  process.exit(1);
}

const PROD = process.env.PROD_BASE_URL || "https://portfoliorank.dev";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : PREWARM_LIMIT;

const db = pipelineDb(path.join(import.meta.dirname, ".."));
await ensureRosterSchema(db);
// Only sites on the current list (data/feed.json) can be scored: rows that
// left it are marked delisted and skipped.
await syncRoster(db, feed);

// Listed, live, not "not a portfolio", with the devices whose Lighthouse
// result is due (lib/freshness.mjs; scripts/lib/prewarm.mjs prewarmQueue).
const sites = await prewarmQueue(db, { active: ACTIVE, limit: LIMIT });

console.log(`prewarming PSI + inspect for ${sites.length} site(s) with due metrics, inspect via ${PROD}`);
const gap = Number(process.env.PSI_RUN_GAP_MS);
const gapMs = process.env.PSI_RUN_GAP_MS && Number.isFinite(gap) && gap >= 0 ? gap : DEFAULT_RUN_GAP_MS;
// How long to wait before each retry of a call refused for a per-minute limit (PSI_RATE_WAITS_MS="15000,30000,60000"; tests set "0,0,0").
const waits = process.env.PSI_RATE_WAITS_MS ? process.env.PSI_RATE_WAITS_MS.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0) : RATE_LIMIT_WAITS_MS;
const { exitCode, summary, verdict } = await runPrewarm({
  urls: sites,
  base: PROD,
  measure: ({ url, devices }) => measureAndStore(db, url, { devices, run: (target, strategy) => runPsiCall(target, strategy), gapMs, waits }),
  pauseMs: Number(process.env.PREWARM_PAUSE_MS ?? 1200), // gentle pacing
  // Four PageSpeed runs a full measure (two phone, two desktop): sites go a few at a time (lib/psi-pacing.mjs).
  concurrency: Number(process.env.PREWARM_CONCURRENCY ?? PREWARM_CONCURRENCY),
});
console.log(`\n${summary}`);
// The Actions job summary shows the table on the run page.
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (exitCode !== 0) console.error(`::error::${verdict}`);
process.exit(exitCode);
