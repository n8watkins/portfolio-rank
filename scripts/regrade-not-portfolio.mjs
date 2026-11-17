#!/usr/bin/env node
// One-off re-check of every listed portfolio graded "not a portfolio"
// (owner, 2026-11-13): the 103 graded by gemini-3.1-flash-lite or rubric v1,
// and the rubric v2 "no" verdicts. It captured each site again, ran the
// narrow code rules (pipeline/junk-rules.mjs, #212), then graded it with the
// production grade, within hard Gemini caps (CAP for the job, under DAY_LIMIT
// for the Pacific day), keeping each site's outcome in the cache table
// (regrade-np:<url>).
//
// The re-check is finished, and the script no longer grades: since
// 2026-11-16 every AI grade is stored through the door (lib/reviews/door.mjs),
// which writes the owner's review row and never lets one "no" remove a site
// silently, and this script predates it. Its grading path was deleted; what
// is left reads what the re-check did.
//
// Run it from GitHub Actions, "Re-check not-a-portfolio grades"
// (.github/workflows/regrade-not-portfolio.yml), or by hand with TURSO_* in
// the environment:
//   node scripts/regrade-not-portfolio.mjs --dry-run      # the list and the budget it had
//   node scripts/regrade-not-portfolio.mjs --report       # what the re-check did
//   node scripts/regrade-not-portfolio.mjs                # refuses: it no longer grades
import path from "node:path";
import { pipelineDb, AI_WORK } from "../pipeline/roster.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { ensureRubricHistory } from "../pipeline/rubric-history.mjs";
import { guardedForReview } from "../pipeline/portfolio-guard.mjs";
import { quotaDay } from "../pipeline/quota-day.mjs";

export const JOB = "regrade-not-portfolio";
export const FINISHED_MESSAGE =
  "regrade-not-portfolio is a finished one-off and refuses to write grades: every AI grade now goes through the door (lib/reviews/door.mjs). Use --dry-run or --report.";
/** Gemini requests the job could ever send, retries included (kept for --dry-run's budget line). */
export const CAP = 160;
/** Gemini requests for the Pacific day, all jobs together, the job stayed under. */
export const DAY_LIMIT = 480;
const STATE = (url) => `regrade-np:${url}`;
const SITE = process.env.SITE_URL || "https://portfoliorank.dev";

/** The sites the re-check covered: listed, shown, with a stored is_portfolio=false (or one it already re-graded). */
export async function candidates(db) {
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.ai_rubric FROM portfolios p
        WHERE ${AI_WORK("p")} AND json_valid(p.ai_rubric)
          AND (json_extract(p.ai_rubric, '$.is_portfolio') = 0
               OR EXISTS (SELECT 1 FROM cache c WHERE c.k = 'regrade-np:' || p.url))
        ORDER BY p.url`
    )
  ).rows;
  return rows.map((r) => {
    const g = JSON.parse(String(r.ai_rubric));
    return { url: String(r.url), name: String(r.name ?? ""), model: g.model ?? null, version: Number(g.rubric_version ?? 1) };
  });
}

/** The before-grade's group: "legacy" (3.1 or rubric v1) or "v2". */
export const groupOf = (c) => (c.version < 2 || /3\.1/.test(String(c.model ?? "")) ? "legacy" : "v2");

async function readState(db, url) {
  const r = (await db.execute({ sql: "SELECT v FROM cache WHERE k = ?", args: [STATE(url)] })).rows[0];
  return r ? JSON.parse(String(r.v)) : null;
}

/** Requests logged for this job (ever) and for the Pacific day (all jobs). */
export async function usage(db, now = new Date()) {
  const { start, end } = quotaDay(now);
  const n = async (sql, args) => Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
  return {
    job: await n("SELECT COUNT(*) AS n FROM gemini_requests WHERE job = ?", [JOB]),
    day: await n("SELECT COUNT(*) AS n FROM gemini_requests WHERE at >= ? AND at < ?", [start.toISOString(), end.toISOString()]),
  };
}

/** The outcome of a new grade. */
export function outcomeOf(grade) {
  if (guardedForReview(grade)) return "needs_review";
  return grade?.is_portfolio === false ? "not_portfolio" : "portfolio";
}

/** Outcomes, in report order: the path each took and what it means. */
export const OUTCOMES = {
  junk_rule: "Not a portfolio by a narrow code rule (no Gemini)",
  not_portfolio: "Still not a portfolio (Gemini)",
  needs_review: "Kept as a portfolio for review: strong signals (Gemini said no)",
  portfolio: "Flipped to portfolio (Gemini)",
};

/** Counts per path and outcome, with profile links. */
export async function report(db, { print = true } = {}) {
  const list = await candidates(db);
  const out = Object.fromEntries([...Object.keys(OUTCOMES), "pending"].map((k) => [k, []]));
  const copies = [];
  const failedCaptures = [];
  for (const c of list) {
    const s = await readState(db, c.url);
    (s?.outcome ? out[s.outcome] : out.pending).push(c.url);
    if (s?.copy) copies.push(c.url);
    if (s && !s.outcome && s.captured === false) failedCaptures.push(c.url);
  }
  if (!print) return { ...out, copies, failedCaptures };
  const link = (u) => `${SITE}/p/${encodeURIComponent(u)}`;
  console.log(`\nRe-check of "not a portfolio" grades (${list.length} sites):`);
  console.log(`  By code rule, no Gemini: ${out.junk_rule.length} not a portfolio`);
  console.log(`  By Gemini plus the guard: ${out.portfolio.length} flipped to portfolio, ${out.needs_review.length} needs review, ${out.not_portfolio.length} still not a portfolio`);
  if (copies.length) console.log(`  Same text on another domain (flagged for review too): ${copies.length}`);
  if (out.pending.length) console.log(`  Not done yet: ${out.pending.length}${failedCaptures.length ? ` (${failedCaptures.length} didn't load for a fresh capture)` : ""}`);
  for (const [k, title] of Object.entries(OUTCOMES)) {
    if (!out[k].length) continue;
    console.log(`\n${title}:`);
    for (const u of out[k]) console.log(`  ${u}  ${link(u)}`);
  }
  return { ...out, copies, failedCaptures };
}

async function main() {
  const args = process.argv.slice(2);
  const ROOT = path.join(import.meta.dirname, "..");
  const db = pipelineDb(ROOT);
  await ensureGeminiLog(db);
  await ensureRubricHistory(db);
  if (args.includes("--report")) return void (await report(db));

  const list = await candidates(db);
  const groups = { legacy: 0, v2: 0 };
  for (const c of list) groups[groupOf(c)]++;
  const startUse = await usage(db);
  console.log(`${list.length} site(s) to re-check: ${groups.legacy} graded by 3.1 or rubric v1, ${groups.v2} by rubric v2.`);
  console.log(`Gemini so far: ${startUse.job} of ${CAP} for this job; ${startUse.day} today (Pacific), limit ${DAY_LIMIT}.`);
  if (args.includes("--dry-run")) return;
  throw new Error(FINISHED_MESSAGE);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
