#!/usr/bin/env node
// Read-only: the stored facts of the sample's sites, for comparison with the
// audit's own measurement. Run with a read-only token:
//
//   TURSO_DATABASE_URL=libsql://... pass-env run -e TURSO_AUTH_TOKEN=<read-only entry> -- \
//     node scripts/experiments/facts-audit/read-prod-facts.mjs <out.json>
//
// Only SELECTs; nothing is written.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";

const out = process.argv[2];
if (!out) throw new Error("usage: read-prod-facts.mjs <out.json>");
const sample = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "sample.json"), "utf8"));
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const rows = [];
for (const s of sample) {
  const r = await db.execute({
    sql: `SELECT url, status, captured_at, facts_at, facts, signals, needs_review, length(page_text) AS text_chars,
                 json_extract(ai_rubric, '$.is_portfolio') AS is_portfolio, json_extract(ai_rubric, '$.review.kind') AS review_kind
          FROM portfolios WHERE url = ?`,
    args: [s.url],
  });
  const row = r.rows[0];
  rows.push(row ? { ...Object.fromEntries(Object.entries(row)), facts: JSON.parse(String(row.facts ?? "null")), signals: JSON.parse(String(row.signals ?? "null")) } : { url: s.url, missing: true });
}
fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`${rows.length} rows, ${rows.filter((r) => r.missing).length} missing -> ${out}`);
