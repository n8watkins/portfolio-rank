// Re-inspect sites whose cached inspect was unreachable OR found no GitHub, now
// that inspect has the /about fallback + a browser-like UA. Busts the stale
// cache row, then re-fetches via prod (which re-caches the improved result).
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

const rows = (
  await db.execute("SELECT k, v FROM cache WHERE k LIKE 'inspect:%'")
).rows;
const targets = [];
for (const r of rows) {
  let v;
  try {
    v = JSON.parse(String(r.v));
  } catch {
    continue;
  }
  if (!v.ok || !v.githubUrl) targets.push(String(r.k).slice(8));
}
console.log(`retrying ${targets.length} sites (unreachable or no GitHub)`);

let found = 0;
let reachable = 0;
for (const [i, u] of targets.entries()) {
  await db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [`inspect:${u}`] });
  try {
    const res = await fetch(`${PROD}/api/inspect?url=${encodeURIComponent(u)}`, {
      signal: AbortSignal.timeout(30000),
    });
    const d = await res.json();
    if (d?.ok) reachable++;
    if (d?.githubUrl) found++;
    if (i % 25 === 0)
      console.log(`[${i + 1}/${targets.length}] ${u} → gh=${d?.githubUrl ?? "-"}`);
  } catch {
    /* still unreachable */
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`done: ${reachable} now reachable, ${found} GitHubs recovered`);
process.exit(0);
