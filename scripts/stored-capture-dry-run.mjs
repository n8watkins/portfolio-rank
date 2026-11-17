#!/usr/bin/env node
// Dry run of the night's stored-capture check (pipeline/night.mjs
// scanStoredCaptures, lib/reviews/stored-capture.mjs): how many of the sites
// waiting for "grade new sites" the first grading night would set aside
// because their stored capture does not show the site, why, and up to ten
// examples per reason. Reads the database only; writes nothing.
//
// Against production (the Turso keys from .env.pass):
//   pass-env run -- node scripts/stored-capture-dry-run.mjs
// Against the local file (data/portfoliorank.db, or LOCAL_DB_FILE):
//   node scripts/stored-capture-dry-run.mjs
//   node scripts/stored-capture-dry-run.mjs --examples 20
import path from "node:path";
import { ACTIVE, pipelineDb } from "../pipeline/roster.mjs";
import { scanStoredCaptures } from "../pipeline/night.mjs";
import { CAPTURE_CHECKED_SINCE, isBotWall, parseObject } from "../lib/reviews/stored-capture.mjs";
import { parseRubric } from "../pipeline/rubric-history.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const at = args.indexOf("--examples");
const EXAMPLES = at >= 0 ? Number(args[at + 1]) || 10 : 10;

const db = pipelineDb(ROOT);
const byWhy = new Map();
let hiddenAfter = 0;
let refresh = 0;
const { scanned, blocked } = await scanStoredCaptures(db, {
  onPage: async (page) => {
    for (const { row, why } of page) {
      const list = byWhy.get(why) ?? [];
      list.push(row);
      byWhy.set(why, list);
      if (parseRubric(row.ai_rubric)) refresh++;
    }
  },
});
// What setting them aside would hide: a failed capture is hidden unless the weekly health check has it live.
const urls = [...byWhy.values()].flat().map((r) => String(r.url));
for (let i = 0; i < urls.length; i += 200) {
  const part = urls.slice(i, i + 200);
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM portfolios WHERE url IN (${part.map(() => "?").join(",")}) AND COALESCE(health, '') != 'live'`,
    args: part,
  });
  hiddenAfter += Number(r.rows[0].n);
}
const waiting = Number(
  (
    await db.execute(
      `SELECT COUNT(*) AS n FROM portfolios p WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${ACTIVE("p")}
         AND p.page_text IS NOT NULL AND p.facts IS NOT NULL AND p.ai_rubric IS NULL`
    )
  ).rows[0].n
);

console.log(`Stored-capture check, dry run (nothing written). Captures before ${CAPTURE_CHECKED_SINCE} UTC are judged; later ones passed the capture's own check.`);
console.log(`Waiting for a first grade (no grade yet): ${waiting}. Unchecked captures scanned in the queue: ${scanned}.`);
console.log(`Would be set aside: ${blocked} (${refresh} keep their grade and get a new capture asked for; the rest become a failed capture, retried by the next capture run).`);
console.log(`Of those, ${hiddenAfter} would be hidden until a new capture succeeds (their health is not 'live').`);
for (const [why, rows] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${why}: ${rows.length}${isBotWall(why) ? " (bot wall: also sent to the owner's review)" : ""}`);
  for (const r of rows.slice(0, EXAMPLES)) {
    const facts = parseObject(r.facts) ?? {};
    const text = String(r.page_text ?? "").replace(/\s+/g, " ").trim();
    console.log(`- ${r.url} (captured ${r.captured_at ?? "?"}, signals ${facts.signals?.score ?? "?"}): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
  }
}
