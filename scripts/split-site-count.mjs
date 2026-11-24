#!/usr/bin/env node
// How many sites the list has split by respelling an address
// (pipeline/list-key.mjs splitSites): a delisted row and a listed row with the
// same key. The nightly sync writes the same count to its job summary; this
// prints it on demand, with what each old row still holds, so the cost of the
// splits can be read. Reads the database only; writes nothing.
//
// Against production: pass-env run -- node scripts/split-site-count.mjs
// Against the local file (data/portfoliorank.db, or LOCAL_DB_FILE):
//   node scripts/split-site-count.mjs [--examples 10]
import path from "node:path";
import { pipelineDb } from "../pipeline/roster.mjs";
import { splitSites } from "../pipeline/list-key.mjs";
import { parseRubric } from "../pipeline/rubric-history.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--examples");
const EXAMPLES = at >= 0 ? Number(args[at + 1]) || 10 : 10;

const db = pipelineDb(path.join(import.meta.dirname, ".."));
const rows = (await db.execute("SELECT url, delisted_at, ai_rubric, shot_key FROM portfolios")).rows;
const byUrl = new Map(rows.map((r) => [String(r.url), r]));
const { splits, unclear } = splitSites(rows.map((r) => ({ url: String(r.url), delistedAt: r.delisted_at })));

// parseRubric returns only a real Gemini answer, any rubric version (pipeline/rubric.mjs geminiAnswered).
const graded = (url) => Boolean(parseRubric(byUrl.get(url)?.ai_rubric));
const captured = (url) => Boolean(byUrl.get(url)?.shot_key);
const count = (f) => splits.filter(f).length;

const listed = rows.filter((r) => r.delisted_at == null).length;
console.log(`Rows: ${rows.length} (${listed} listed, ${rows.length - listed} delisted).`);
console.log(`Split sites: ${splits.length} (${count((s) => s.from.length > 1)} respelled more than once). Unclear, two listed rows for one key: ${unclear.length}.`);
console.log(`Old row holds a grade: ${count((s) => s.from.some(graded))}. Old row holds a capture: ${count((s) => s.from.some(captured))}.`);
console.log(`Listed row already graded: ${count((s) => graded(s.to))}. Graded on both rows (graded twice): ${count((s) => graded(s.to) && s.from.some(graded))}.`);
console.log(`Old row graded, listed row not (would be graded again): ${count((s) => !graded(s.to) && s.from.some(graded))}.`);
for (const s of splits.slice(0, EXAMPLES)) console.log(`- ${s.from.join(", ")} -> ${s.to}`);
