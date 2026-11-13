#!/usr/bin/env node
// One-off re-check of every listed portfolio graded "not a portfolio"
// (owner, 2026-11-13): the 103 graded by gemini-3.1-flash-lite or rubric v1,
// and the rubric v2 "no" verdicts. For each: a fresh capture (with the
// splash click-through, pipeline/splash.mjs), then the current production
// grade (rubric v2 on gemini-3.5-flash-lite, pipeline/night.mjs
// gradeFromEvidence), which applies the strong-signals guard
// (pipeline/portfolio-guard.mjs). The old grade moves to rubric_history.
//
// Gemini is capped hard: at most CAP requests for this job in total,
// retries included (every request is logged in gemini_requests as
// job=regrade-not-portfolio and counted before each send), and never past
// DAY_LIMIT requests for the Pacific day, all jobs together. Resumable: each
// site's progress is kept in the cache table (regrade-np:<url>), so a second
// run picks up where the first stopped.
//
// Run it from GitHub Actions, "Re-check not-a-portfolio grades"
// (.github/workflows/regrade-not-portfolio.yml), which has the secrets the
// nightly checks use. By hand (TURSO_*, GEMINI_API_KEY and R2_* in the environment, as the
// nightly scripts get them):
//   node scripts/regrade-not-portfolio.mjs --dry-run      # the list and the budget, nothing sent
//   node scripts/regrade-not-portfolio.mjs                # capture, grade, report
//   node scripts/regrade-not-portfolio.mjs --report       # the report only
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipelineDb, ACTIVE } from "../pipeline/roster.mjs";
import { PRIMARY_MODEL, createGemini, createLimiter } from "../pipeline/gemini.mjs";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { gradeFromEvidence } from "../pipeline/night.mjs";
import { ensureRubricHistory, replaceGradeStatements } from "../pipeline/rubric-history.mjs";
import { RUBRIC_VERSION } from "../pipeline/rubric.mjs";
import { guardedForReview } from "../pipeline/portfolio-guard.mjs";
import { rankForWrite } from "../lib/tiers-store.mjs";
import { quotaDay } from "../pipeline/quota-day.mjs";

export const JOB = "regrade-not-portfolio";
/** Gemini requests this job may ever send, retries included. */
export const CAP = 160;
/** Gemini requests for the Pacific day, all jobs together, this job stays under. */
export const DAY_LIMIT = 480;
const STATE = (url) => `regrade-np:${url}`;
const SITE = process.env.SITE_URL || "https://portfoliorank.dev";

/** The sites to re-check: listed, shown, with a stored is_portfolio=false (or one this job already re-graded). */
export async function candidates(db) {
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.ai_rubric FROM portfolios p
        WHERE ${ACTIVE("p")} AND json_valid(p.ai_rubric)
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
async function writeState(db, url, state) {
  await db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [STATE(url), JSON.stringify(state), Date.now()] });
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

/**
 * A fetch that refuses to send once the caps would be passed, counting
 * every attempt (retries too) from the logged totals at the start.
 */
export function cappedFetch(start, { cap = CAP, dayLimit = DAY_LIMIT, fetchImpl = globalThis.fetch } = {}) {
  let sent = 0;
  const f = async (input, init) => {
    if (start.job + sent >= cap || start.day + sent >= dayLimit - 1) {
      f.exhausted = true;
      throw Object.assign(new Error("regrade budget spent"), { name: "BudgetError" });
    }
    sent++;
    return fetchImpl(input, init);
  };
  f.exhausted = false;
  f.sent = () => sent;
  return f;
}

/** The outcome of a new grade. */
export function outcomeOf(grade) {
  if (guardedForReview(grade)) return "needs_review";
  return grade?.is_portfolio === false ? "not_portfolio" : "portfolio";
}

function imageOf(root, shotKey) {
  const file = path.join(root, "captures", String(shotKey), "hero.jpg");
  if (!fs.existsSync(file) || fs.statSync(file).size > 5 * 1024 * 1024) return null;
  return { inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(file).toString("base64") } };
}

async function report(db) {
  const list = await candidates(db);
  const out = { portfolio: [], not_portfolio: [], needs_review: [], pending: [] };
  for (const c of list) {
    const s = await readState(db, c.url);
    (s?.outcome ? out[s.outcome] : out.pending).push(c.url);
  }
  const link = (u) => `${SITE}/p/${encodeURIComponent(u)}`;
  console.log(`\nRe-check of "not a portfolio" grades (${list.length} sites):`);
  console.log(`  flipped to portfolio: ${out.portfolio.length}`);
  console.log(`  needs review (strong signals): ${out.needs_review.length}`);
  console.log(`  still not a portfolio: ${out.not_portfolio.length}`);
  if (out.pending.length) console.log(`  not done yet: ${out.pending.length}`);
  for (const [k, title] of [["not_portfolio", "Still not a portfolio"], ["needs_review", "Needs review"], ["portfolio", "Flipped to portfolio"]]) {
    if (!out[k].length) continue;
    console.log(`\n${title}:`);
    for (const u of out[k]) console.log(`  ${u}  ${link(u)}`);
  }
  return out;
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
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  // 1. Fresh captures, with the splash click-through, for the sites not captured by this job yet.
  const states = new Map();
  for (const c of list) states.set(c.url, (await readState(db, c.url)) ?? { before: { model: c.model, version: c.version } });
  const toCapture = list.filter((c) => !states.get(c.url).captured).map((c) => c.url);
  if (toCapture.length) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regrade-np-"));
    const file = path.join(dir, "urls.txt");
    fs.writeFileSync(file, toCapture.join("\n"));
    const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    console.log(`Capturing ${toCapture.length} site(s)...`);
    spawnSync(process.execPath, [path.join(ROOT, "pipeline", "capture.mjs"), "--recapture", file, "--concurrency", "3"], { stdio: "inherit", cwd: ROOT, env: process.env });
    for (const url of toCapture) {
      const r = (await db.execute({ sql: "SELECT captured_at FROM portfolios WHERE url = ?", args: [url] })).rows[0];
      const fresh = r?.captured_at && String(r.captured_at) >= startedAt;
      const s = { ...states.get(url), captured: Boolean(fresh), capture: fresh ? "fresh" : "kept the old capture (the site didn't load)" };
      states.set(url, s);
      await writeState(db, url, s);
    }
  }

  // 2. The current production grade, within the caps.
  const fetchImpl = cappedFetch(startUse);
  const log = createRequestLog({ db, job: JOB });
  const gemini = createGemini({
    apiKey: process.env.GEMINI_API_KEY,
    models: [PRIMARY_MODEL],
    limiter: createLimiter({ rpm: 10 }),
    retryDelaysMs: [10000, 30000],
    maxSlowdowns: 2,
    onDailyQuota: "stop",
    fetchImpl,
    onRequest: (r) => log.record(r),
  });
  for (const c of list) {
    const s = states.get(c.url);
    if (s.outcome) continue;
    if (fetchImpl.exhausted) break;
    const row = (await db.execute({ sql: "SELECT url, name, shot_key, meta, page_text, facts, ai_rubric FROM portfolios WHERE url = ?", args: [c.url] })).rows[0];
    const image = row?.shot_key ? imageOf(ROOT, row.shot_key) : null;
    if (!image) {
      console.log(`${c.url}: no fresh screenshot here, left for a later run`);
      continue;
    }
    try {
      const now = new Date();
      const grade = await rankForWrite(db, await gradeFromEvidence(gemini, { row, image, now }), { url: c.url, now: now.getTime() });
      await db.batch(replaceGradeStatements(c.url, row.ai_rubric, grade, now), "write");
      const outcome = outcomeOf(grade);
      const done = { ...s, outcome, after: { model: grade.model, version: RUBRIC_VERSION, is_portfolio: grade.is_portfolio, tier: grade.tier ?? null, review: grade.review?.reason ?? null }, at: now.toISOString() };
      states.set(c.url, done);
      await writeState(db, c.url, done);
      console.log(`${c.url}: ${outcome}`);
    } catch (e) {
      if (fetchImpl.exhausted) {
        console.log(`Stopped: the Gemini cap is reached (${CAP} for this job, under ${DAY_LIMIT} today).`);
        break;
      }
      if (/quota/i.test(String(e?.name ?? "") + String(e?.message ?? ""))) {
        console.log(`Stopped: Gemini's daily quota is spent (${String(e?.message ?? e).slice(0, 120)}).`);
        break;
      }
      console.log(`${c.url}: grade failed (${String(e?.message ?? e).slice(0, 160)}), left for a later run`);
    }
  }
  console.log(`Gemini this run: ${fetchImpl.sent()} request(s).`);
  await report(db);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
