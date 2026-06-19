// One-off cleanup: purge all gemini-2.5-flash data so the dataset is 100%
// gemini-3.1-flash-lite. The 2 stale rubrics go NULL (re-graded next run); all
// AI votes + ratings are wiped to a clean ELO slate (only 4 votes existed, no
// humans) and will be re-seeded by a fresh pairwise run on 3.1-flash-lite.
import { createClient } from "@libsql/client";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const r1 = await db.execute(
  "UPDATE portfolios SET ai_rubric = NULL WHERE json_extract(ai_rubric,'$.model') = 'gemini-2.5-flash'"
);
const r2 = await db.execute("DELETE FROM votes");
const r3 = await db.execute("DELETE FROM ratings");
console.log(`rubrics cleared: ${r1.rowsAffected}`);
console.log(`votes deleted:   ${r2.rowsAffected}`);
console.log(`ratings deleted: ${r3.rowsAffected}`);

const left = await db.execute(
  "SELECT json_extract(ai_rubric,'$.model') m, COUNT(*) c FROM portfolios WHERE ai_rubric IS NOT NULL GROUP BY m"
);
console.log("rubrics remaining by model:", left.rows.map((r) => `${r.m}:${r.c}`).join("  "));
process.exit(0);
