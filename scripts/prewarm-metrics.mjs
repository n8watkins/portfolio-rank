// Prewarm the PSI (Lighthouse) + inspect (polish) caches for graded S/A/B sites
// by hitting the prod API endpoints, which cache results to Turso (shared with
// the pipeline). This is what makes the daily voting robot's metrics-enriched
// comparisons actually have metrics — otherwise the cache is only filled lazily
// by real visitors. Paced; safe to re-run (endpoints serve cache when fresh).
//
// Usage: node scripts/prewarm-metrics.mjs [--limit=N]
import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PROD = process.env.PROD_BASE_URL || "https://portfoliorank.vercel.app";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 150;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// S/A/B sites missing fresh metrics are prioritized: order by url and let the
// endpoint's own cache short-circuit already-warm ones cheaply.
const rows = (
  await db.execute(
    "SELECT url FROM portfolios WHERE status='live' AND json_extract(ai_rubric,'$.tier') IN ('S','A','B') ORDER BY url"
  )
).rows.slice(0, LIMIT);

console.log(`prewarming PSI + inspect for ${rows.length} S/A/B site(s) via ${PROD}`);
let ok = 0;
for (const [i, r] of rows.entries()) {
  const u = encodeURIComponent(String(r.url));
  for (const ep of ["inspect", "psi"]) {
    try {
      const res = await fetch(`${PROD}/api/${ep}?url=${u}`, {
        signal: AbortSignal.timeout(60000),
      });
      console.log(`[${i + 1}/${rows.length}] ${ep} ${r.url} -> ${res.status}`);
    } catch (e) {
      console.log(
        `[${i + 1}/${rows.length}] ${ep} ${r.url} -> ERR ${String(e.message).slice(0, 60)}`
      );
    }
    await new Promise((res) => setTimeout(res, 1200)); // gentle pacing
  }
  ok++;
}
console.log(`done: prewarmed ${ok} site(s)`);
process.exit(0);
