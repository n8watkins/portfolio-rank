// Read-only export of the portfolios table from the production Turso DB.
// Writes experiments/junk-detection/local/all.json (gitignored).
// Usage: node experiments/junk-detection/export.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cols = ["url", "name", "status", "reason", "shot_key", "ai_rubric", "delisted_at", "health", "final_url", "signals", "page_text", "facts", "meta"];
const obj = cols.map((c) => `'${c}',${c}`).join(",");
// hex() keeps every row on one output line, whatever the text holds.
const sql = `select hex(json_object(${obj})) from portfolios where rowid between 1 and 100000000`;
const out = execFileSync(join(homedir(), ".turso/turso"), ["db", "shell", "portfolio-rank", sql], { maxBuffer: 1 << 30, encoding: "utf8" });

const rows = [];
for (const line of out.split("\n").slice(1)) {
  const hex = line.trim();
  if (!hex) continue;
  const r = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
  for (const k of ["ai_rubric", "facts", "signals", "meta"]) {
    if (typeof r[k] === "string") {
      try {
        r[k] = JSON.parse(r[k]);
      } catch {
        /* keep the raw string */
      }
    }
  }
  rows.push(r);
}
mkdirSync(join(here, "local"), { recursive: true });
writeFileSync(join(here, "local/all.json"), JSON.stringify(rows));
console.log(`exported ${rows.length} rows`);
