// One-off: export Gemini ai_rubric grades from Turso to local CSV + markdown.
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "fs";

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

const tierRank = { S: 0, A: 1, B: 2, C: 3, D: 4 };
const recs = rows
  .map((r) => {
    const j = JSON.parse(r.ai_rubric);
    return {
      name: r.name,
      url: r.url,
      tier: j.tier,
      is_portfolio: j.is_portfolio,
      visual_design: j.visual_design?.score,
      five_second: j.five_second_test?.score,
      storytelling: j.storytelling?.score,
      writing: j.writing?.score,
      memorability: j.memorability?.score,
      motion: j.motion?.score,
      model: j.model,
    };
  })
  .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.visual_design - a.visual_design);

const cols = [
  "tier", "is_portfolio", "visual_design", "five_second", "storytelling",
  "writing", "memorability", "motion", "name", "url", "model",
];
const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const csv = [cols.join(",")]
  .concat(recs.map((r) => cols.map((c) => esc(r[c])).join(",")))
  .join("\n");
writeFileSync("ai-grades.csv", csv);

const top = recs.filter((r) => r.tier === "S" || r.tier === "A");
const md = [
  `# Gemini AI Grades — S & A tier (${top.length} of ${recs.length} graded)\n`,
  "| Tier | Design | 5s | Story | Write | Mem | Motion | Name | URL |",
  "|---|---|---|---|---|---|---|---|---|",
]
  .concat(
    top.map(
      (r) =>
        `| ${r.tier} | ${r.visual_design} | ${r.five_second} | ${r.storytelling} | ${r.writing} | ${r.memorability} | ${r.motion} | ${r.name} | ${r.url} |`
    )
  )
  .join("\n");
writeFileSync("ai-grades-top.md", md);

console.log(`Wrote ai-grades.csv (${recs.length} rows) and ai-grades-top.md (${top.length} S/A sites)`);
console.log("Model(s):", [...new Set(recs.map((r) => r.model))].join(", "));
console.log(`\n=== S TIER (${recs.filter((r) => r.tier === "S").length}) ===`);
recs.filter((r) => r.tier === "S").forEach((r) => console.log(`  ${r.url}  (design ${r.visual_design})`));
console.log(`\nnot real portfolios (is_portfolio=false): ${recs.filter((r) => !r.is_portfolio).length}`);
process.exit(0);
