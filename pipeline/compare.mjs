#!/usr/bin/env node
// The new daily AI comparison job (ranking v2, RANKING.md). Off unless the
// RANKING_V2 variable is "true": until the owner switches the leaderboard
// over, the daily vote job (judge.mjs pairwise) keeps running as before and
// this script exits at once without touching Gemini or the database.
//
// When on, each run:
//   1. rebuilds the AI view in memory from the stored comparisons
//      (lib/ranking/views.mjs) to know every site's current rating
//   2. plans today's one-on-one pairs and batched groups with the
//      matchmaking module (lib/ranking/matchmaking.mjs), seeded with the
//      date, so the plan can be reproduced
//   3. asks gemini-3.5-flash-lite only (owner decision 2026-11-10: AI
//      comparisons never use 3.1; when 3.5 is busy after its retries or its
//      quota is spent, the rest waits for the next run)
//   4. stores every answer in `comparisons` with the rater, model, prompt
//      version, method, order shown, matchmaking seed and slot kind
//
// Daily budgets come from lib/ranking/config.mjs (RANKING_BUDGET overrides,
// default 100 one-on-one and 100 batched) and count what was already stored
// today, so a second run on the same day only does the rest. Batched results
// are stored like any other but count in the AI and Merged views only when
// RANKING_BATCHED_COUNTS is "true" (experiment only until then).
//
// Usage: node pipeline/compare.mjs [--rpm R] [--one-on-one N] [--batched N]
import { createGemini, createLimiter, DEFAULT_RPM, GeminiAuthError, GeminiUnavailableError } from "./gemini.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog, runSummary } from "./gemini-log.mjs";
import { judgeOutcome } from "./judge-outcome.mjs";
import { ACTIVE, NOT_PORTFOLIO, loadFeed, pipelineDb, syncRoster } from "./roster.mjs";
import { PAIR_SCHEMA, buildBatchRequest, buildPairRequest, parseBatchAnswer, parsePairAnswer } from "./compare-prompts.mjs";
import {
  PAIR_COOLDOWN_DAYS,
  PROMPT_VERSION_BATCHED,
  PROMPT_VERSION_ONE_ON_ONE,
  rankingConfig,
} from "../lib/ranking/config.mjs";
import { planBatches, planPairs, pairKey } from "../lib/ranking/matchmaking.mjs";
import { comparisonsToday, ensureRankingSchema, insertComparison, loadInput, syncVotes } from "../lib/ranking/store.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const config = rankingConfig();
if (!config.enabled) {
  console.log("RANKING_V2 is not \"true\": the new comparison job is off, nothing to do.");
  process.exit(0);
}
for (const name of ["GEMINI_API_KEY", "SHOTS_BASE_URL"]) {
  if (!process.env[name]) {
    console.error(`${name} is required`);
    process.exit(1);
  }
}
const SHOTS_BASE = process.env.SHOTS_BASE_URL.replace(/\/+$/, "");
const RPM = Number(flag("rpm", process.env.GEMINI_RPM || String(DEFAULT_RPM)));
const RUN_ID = process.env.GITHUB_RUN_ID ?? null;
const RATER_ID = `ai:${config.model}`;

const db = pipelineDb(ROOT);
await ensureGeminiLog(db);
await ensureRankingSchema(db);
const requestLog = createRequestLog({ db, job: "compare" });
// One model, no backup: a spent daily quota stops the run ("stop"), and an
// overloaded 3.5 is retried on 3.5 only.
const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY,
  models: [config.model],
  limiter: createLimiter({ rpm: RPM }),
  onRequest: (r) => requestLog.record(r),
  onDailyQuota: "stop",
});

// Hero screenshots from the public R2 bucket. Only a success or a definite
// 404 is cached; a transient failure may succeed on a later pair.
const heroCache = new Map();
async function hero(key, budgetBytes = 5 * 1024 * 1024) {
  if (heroCache.has(key)) return heroCache.get(key);
  try {
    const res = await fetch(`${SHOTS_BASE}/${key}/hero.jpg`, { signal: AbortSignal.timeout(20000) });
    if (res.status === 404) {
      heroCache.set(key, null);
      return null;
    }
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const part = buf.length > budgetBytes ? null : { inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } };
    heroCache.set(key, part);
    return part;
  } catch {
    return null;
  }
}

async function run() {
  const roster = await syncRoster(db, await loadFeed(ROOT));
  if (roster.delisted || roster.relisted) console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
  await syncVotes(db);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const done = await comparisonsToday(db, { now, model: config.model });
  const want = {
    one_on_one: Math.max(0, Number(flag("one-on-one", config.budget.one_on_one)) - done.one_on_one),
    batched: Math.max(0, Number(flag("batched", config.budget.batched)) - done.batched),
  };
  console.log(`today: ${done.one_on_one} one-on-one and ${done.batched} batched stored; this run: up to ${want.one_on_one} and ${want.batched}`);

  // Comparable sites: on the list, captured, not graded "not a portfolio".
  const rows = (
    await db.execute(
      `SELECT url, name, shot_key, page_text FROM portfolios p
       WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${ACTIVE("p")} AND NOT ${NOT_PORTFOLIO("p")}`
    )
  ).rows;
  const info = new Map(rows.map((r) => [String(r.url), { name: String(r.name ?? ""), key: String(r.shot_key), pageText: r.page_text == null ? "" : String(r.page_text) }]));
  const input = await loadInput(db);
  const { boards } = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts, history: false });
  const pool = boards.ai.filter((r) => info.has(r.url)).map((r) => ({ url: r.url, mu: r.mu, sigma: r.sigma }));

  const cutoff = new Date(now.getTime() - PAIR_COOLDOWN_DAYS * 86400000).toISOString();
  const aiPairs = input.comparisons.filter((c) => c.rater_type === "ai" && c.method === "one_on_one" && c.ranking);
  const recent = new Set(aiPairs.filter((c) => c.created_at >= cutoff).map((c) => pairKey(c.ranking[0][0], c.ranking[1][0])));
  const past = aiPairs.filter((c) => Array.isArray(c.shown) && c.prompt_version === PROMPT_VERSION_ONE_ON_ONE);

  const seed = `${today}:${done.one_on_one}:${done.batched}`;
  const pairs = planPairs({ sites: pool, n: want.one_on_one, seed, recent, past });
  const batches = planBatches({ sites: pool, n: want.batched, size: config.batchSize, seed });
  console.log(`pool ${pool.length} site(s); planned ${pairs.length} pair(s) and ${batches.length} batch(es) with seed ${seed}`);

  const counts = { queued: 0, ok: 0, abstained: 0, errors: 0, skipped: 0 };
  let stopped = null;
  let consecutiveErrors = 0;
  const jobs = [
    ...pairs.map((p) => ({ ...p, method: "one_on_one" })),
    ...batches.map((b) => ({ ...b, method: "batched" })),
  ];
  for (const job of jobs) {
    counts.queued++;
    const sites = await Promise.all(job.shown.map(async (url) => ({ ...info.get(url), url, image: await hero(info.get(url).key) })));
    if (sites.some((s) => !s.image)) {
      counts.skipped++;
      continue;
    }
    const one = job.method === "one_on_one";
    try {
      const request = one ? buildPairRequest(sites) : buildBatchRequest(sites);
      const { result, model } = await gemini.generate(request.parts, one ? PAIR_SCHEMA : request.schema, request.options);
      const parsed = one ? parsePairAnswer(result, job.shown) : parseBatchAnswer(result, job.shown);
      consecutiveErrors = 0;
      await insertComparison(db, {
        created_at: new Date(),
        rater_type: "ai",
        rater_id: RATER_ID,
        model,
        prompt_version: one ? PROMPT_VERSION_ONE_ON_ONE : PROMPT_VERSION_BATCHED,
        method: job.method,
        shown: job.shown,
        ranking: parsed.ranking,
        outcome: parsed.ranking ? "ranked" : "skip",
        reason: parsed.reason.slice(0, 300),
        match_seed: seed,
        match_kind: job.kind,
        run_id: RUN_ID,
      });
      if (parsed.ranking) counts.ok++;
      else counts.abstained++;
    } catch (e) {
      if (e instanceof GeminiAuthError) throw e;
      counts.errors++;
      console.log(`  ERROR ${job.method} ${job.shown.join(" | ")}: ${String(e.message).slice(0, 160)}`);
      if (e instanceof GeminiUnavailableError) {
        stopped = e.message;
        break;
      }
      if (++consecutiveErrors >= 5) {
        stopped = "5 consecutive errors";
        break;
      }
    }
  }
  console.log(`compare done: ${counts.ok} stored, ${counts.abstained} skipped by the model, ${counts.errors} error(s), ${counts.skipped} without screenshots; ${gemini.summary()}`);
  return { ...counts, stopped };
}

async function writeSummary(outcome, stopped) {
  let today = { markdown: "", warnings: [] };
  try {
    today = await dailyTotals(db);
  } catch {
    /* the request log is optional */
  }
  const md = [
    outcome.summary,
    stopped ? `Stopped early: ${stopped}. The next run continues.\n` : "",
    runSummary(requestLog.rows),
    today.markdown,
  ].join("\n");
  for (const w of today.warnings) console.log(`::warning::${w}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(md);
}

try {
  const counts = await run();
  const outcome = judgeOutcome({ mode: "pairwise", ...counts });
  await writeSummary({ ...outcome, summary: outcome.summary.replace("## AI judge: pairwise", "## AI comparisons (ranking v2)") }, counts.stopped);
  console.log(outcome.verdict);
  if (outcome.exitCode) process.exit(1);
} catch (e) {
  if (!(e instanceof GeminiAuthError)) throw e;
  console.error(`${e.message}\nCheck the GEMINI_API_KEY secret.`);
  process.exit(1);
}
