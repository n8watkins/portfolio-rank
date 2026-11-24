// One-off: export Gemini ai_rubric grades from Turso to local CSV + markdown.
// Only the outputs Gemini is still asked for (rubric v3, owner 2026-11-22 and
// 2026-11-23): is it a portfolio (and why) and the roles. An older grade's
// letter and dropped scores stay in the database and are not exported.
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "fs";
import { geminiAnswered, portfolioReason, versionOf } from "../pipeline/rubric.mjs";

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
const rows = (
  await db.execute("SELECT url, name, ai_rubric FROM portfolios WHERE ai_rubric IS NOT NULL ORDER BY url")
).rows;

const recs = rows
  .map((r) => {
    let j = null;
    try {
      j = JSON.parse(r.ai_rubric);
    } catch {
      j = null;
    }
    return { r, j };
  })
  .filter(({ j }) => geminiAnswered(j))
  .map(({ r, j }) => ({
    name: r.name,
    url: r.url,
    is_portfolio: j.is_portfolio !== false,
    reason: portfolioReason(j),
    roles: Array.isArray(j.roles) ? j.roles.join("; ") : "",
    rubric_version: versionOf(j),
    model: j.model,
  }))
  .sort((a, b) => String(a.url).localeCompare(String(b.url)));

const cols = ["is_portfolio", "reason", "roles", "rubric_version", "name", "url", "model"];
const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const csv = [cols.join(",")]
  .concat(recs.map((r) => cols.map((c) => esc(r[c])).join(",")))
  .join("\n");
writeFileSync("ai-grades.csv", csv);

const no = recs.filter((r) => !r.is_portfolio);
const md = [
  `# Gemini answers: "not a portfolio" (${no.length} of ${recs.length} graded)\n`,
  "| Reason | Roles | Rubric | Name | URL |",
  "|---|---|---|---|---|",
]
  .concat(no.map((r) => `| ${r.reason || "-"} | ${r.roles || "-"} | v${r.rubric_version} | ${r.name} | ${r.url} |`))
  .join("\n");
writeFileSync("ai-grades-not-portfolio.md", md);

console.log(`Wrote ai-grades.csv (${recs.length} rows) and ai-grades-not-portfolio.md (${no.length} sites)`);
console.log("Model(s):", [...new Set(recs.map((r) => r.model))].join(", "));
process.exit(0);
