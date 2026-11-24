// How the sitemap's profiles change with PR #289 (no model running: a code
// test decides which profiles are indexed and listed), on any database, by
// reading only. Prints the profiles in the sitemap today (main's rule: a
// stored Gemini grade with a letter that is not "not a portfolio"), after
// this change (lib/tiers-store.mjs IN_LIBRARY_SQL and the address rule, as
// lib/sitemap-profiles.mjs gradedProfiles reads them), how many are added and
// dropped (dropped should be 0; an address the address rule catches is
// counted apart, as it leaves on purpose), and how many rows hold ai_rubric text that is
// not JSON (main's seedNewcomers fails on such a row).
//
//   node scripts/count-sitemap-change.mjs [--list]
//
// Production: run with a read-only TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in
// the environment (pass-env run -- node scripts/count-sitemap-change.mjs);
// without them it reads LOCAL_DB_FILE or data/portfoliorank.db. Every
// statement is a SELECT; nothing is written. Addresses are printed only with
// --list.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { gradedProfiles, sitemapProfiles } from "../lib/sitemap-profiles.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { ownerMarks } from "../lib/ownership/same-site.mjs";
import { addressNotPortfolio } from "../lib/tiers-store.mjs";

const list = process.argv.includes("--list");
const url = process.env.TURSO_DATABASE_URL;
const db = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });

// Every statement goes through here, so a write can never slip in.
const read = async (stmt) => {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) throw new Error("count-sitemap-change reads only");
  return (await db.execute(stmt)).rows;
};
/** A client for the library's own readers that can only read. */
const readOnly = { execute: (stmt) => read(stmt).then((rows) => ({ rows })), batch: () => Promise.reject(new Error("count-sitemap-change reads only")) };

/**
 * main's rule (lib/sitemap-profiles.mjs GRADED_SQL before this change), in a
 * CASE so text that is not JSON is skipped here instead of failing the count.
 */
const MAIN_SQL = `SELECT p.url FROM portfolios p
  WHERE CASE WHEN json_valid(p.ai_rubric) THEN json_extract(p.ai_rubric, '$.tier') IS NOT NULL
    AND json_extract(p.ai_rubric, '$.error') IS NULL
    AND COALESCE(json_extract(p.ai_rubric, '$.is_portfolio'), 1) != 0 ELSE 0 END`;

const feed = JSON.parse(fs.readFileSync(new URL("../data/feed.json", import.meta.url), "utf8"));
// The sites PortfolioRank does not show (lib/roster.ts hiddenUrls): the health rule and owners' removals.
const marks = await ownerMarks(readOnly);
const hidden = new Set([...(await read(`SELECT url FROM portfolios WHERE ${HIDDEN_WHERE}`)).map((r) => String(r.url)), ...feed.map((p) => p.url).filter((u) => marks.isRemoved(u))]);

const before = sitemapProfiles(feed, hidden, new Set((await read(MAIN_SQL)).map((r) => String(r.url))));
const after = sitemapProfiles(feed, hidden, await gradedProfiles(readOnly));
const was = new Set(before);
const now = new Set(after);
const added = after.filter((u) => !was.has(u));
const finalOf = new Map((await read("SELECT url, final_url FROM portfolios WHERE final_url IS NOT NULL")).map((r) => [String(r.url), String(r.final_url)]));
const byAddress = (u) => addressNotPortfolio({ url: u, final_url: finalOf.get(u) ?? null });
// A code host, Substack, Medium or link-in-bio address leaves on purpose (the address rule); any other drop is a bug.
const droppedByAddress = before.filter((u) => !now.has(u) && byAddress(u));
const dropped = before.filter((u) => !now.has(u) && !byAddress(u));
const notJson = Number((await read("SELECT COUNT(*) AS n FROM portfolios WHERE ai_rubric IS NOT NULL AND NOT json_valid(ai_rubric)"))[0].n);

console.log(`Database: ${url ? "Turso (TURSO_DATABASE_URL)" : "local file"}; list: ${feed.length} addresses, ${hidden.size} hidden`);
console.log(`Profiles in the sitemap today (main's rule): ${before.length}`);
console.log(`Profiles in the sitemap after this change:   ${after.length}`);
console.log(`Added: ${added.length}`);
console.log(`Dropped: ${dropped.length}${dropped.length ? "  <- expected 0: run with --list and look at each" : ""}`);
console.log(`Left out by the address rule (code host, Substack, Medium, link-in-bio; intended): ${droppedByAddress.length}`);
console.log(`Rows whose ai_rubric is not JSON (main's seedNewcomers fails on one): ${notJson}`);
if (list) {
  for (const u of added) console.log(`+ ${u}`);
  for (const u of dropped) console.log(`- ${u}`);
  for (const u of droppedByAddress) console.log(`- (address rule) ${u}`);
}
