// Backfill the inspect cache (socials: GitHub/LinkedIn/X + polish checks) for
// every live site by hitting the prod /api/inspect endpoint, which caches to
// Turso. Skips already-cached sites; safe to re-run. Paced to be gentle.
import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "fs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PROD = process.env.PROD_BASE_URL || "https://portfoliorank.vercel.app";
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const live = (
  await db.execute("SELECT url FROM portfolios WHERE status = 'live' ORDER BY url")
).rows.map((r) => String(r.url));
const cached = new Set(
  (await db.execute("SELECT k FROM cache WHERE k LIKE 'inspect:%'")).rows.map((r) =>
    String(r.k).slice(8)
  )
);
const todo = live.filter((u) => !cached.has(u));
console.log(
  `inspect backfill: ${todo.length} to do (${live.length} live, ${cached.size} already cached)`
);

let ok = 0;
let withGh = 0;
for (const [i, u] of todo.entries()) {
  try {
    const res = await fetch(`${PROD}/api/inspect?url=${encodeURIComponent(u)}`, {
      signal: AbortSignal.timeout(30000),
    });
    const d = await res.json();
    if (d?.githubUrl) withGh++;
    ok++;
    if (i % 25 === 0)
      console.log(`[${i + 1}/${todo.length}] ${u} → gh=${d?.githubUrl ?? "-"}`);
  } catch {
    /* unreachable site — skip */
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`done: ${ok} inspected, ${withGh} with a GitHub link`);
process.exit(0);
