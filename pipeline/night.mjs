// The end-of-day background run (owner decisions 2026-11-10): what is left of
// the day's Gemini 3.5 quota, after people, goes to background AI work in
// priority order, once a night, ending before the quota resets at midnight
// Pacific.
//
// It runs in a Cloudflare Workflow (worker/night.ts) started by the Worker's
// Cron Trigger at 20:30 Pacific; this module holds the logic and knows
// nothing about Workflows, so tests drive it with a simulated clock and a
// mocked Gemini. Every function takes a context:
//
//   ctx = { db, apiKey, plan, quota, rpm, now() -> ms, sleep(ms), log(line),
//           fetchImpl, image(shotKey) -> inline image part | "missing" | null,
//           flags: { rankingV2, rubricRegrade, ranking (lib/ranking/config),
//                    contentMode },
//           content: { env, keys, ai, store } (pipeline/content/engine.mjs),
//           runId }
//
// and a state that is plain JSON (a Workflow step's result), so a run can be
// replayed and resumed step by step:
//
//   startNight   once per night: claims the night in night_runs (a second
//                start the same night does nothing, so a failed or stopped
//                run never restarts itself)
//   planNight    after the free checks: counts each stage's queue and logs
//                the estimate (requests and minutes at the pace)
//   runBatch     one batch: re-reads the quota and people's demand, then
//                spends at most plan.batch requests on the current stage
//   finishNight  writes the summary (estimate and actual, per stage, parked
//                items) to night_runs
//
// The stages, in order (pipeline/budget.mjs STAGES), each with a request cap
// and a wall-clock cap, and all of them stopping 30 minutes before the
// reset:
//   1. Grade new sites: listed, captured, ungraded, with page text and facts
//   2. Grade changed sites: graded before the page fingerprint changed (the
//      nightly checks re-capture sites and record changes in rating_resets)
//   3. AI ranking comparisons (ranking v2, only when RANKING_V2 is on), then
//      the boards are rebuilt. Human face-off votes use no Gemini and are
//      never scheduled.
//   4. Content: the weekly polls (pipeline/polls.mjs), at most one request a
//      night and two a week, then the content engine (pipeline/content/
//      engine.mjs, docs/CONTENT-ENGINE.md) while CONTENT_MODE is not "off":
//      the week's pick on Sunday, one post a night on the drafting nights
//   5. Re-grades: 3.1 grades on 3.5, then (RUBRIC_REGRADE) older rubrics
//   6. Experiments (none scheduled)
//
// No endless retries: each request has the client's own retries (10, 30,
// 60 s for a busy 3.5), the night has a retry budget (plan.retryBudget), a
// stage stops after plan.breaker failures in a row, an item that failed is
// not tried again the same night, and an item that fails on
// plan.parkAfterNights nights in a row is parked (night_item_failures) and
// listed in the summary instead of retried. A spent quota stops the run as
// planned waiting, never as a failure.
import { STAGES, backgroundAllowance, nightTimeline, pacificParts, previousDay, usageToday } from "./budget.mjs";
import {
  createGemini,
  createLimiter,
  GeminiAuthError,
  GeminiQuotaError,
  GeminiRetryBudgetError,
  GeminiUnavailableError,
  PRIMARY_MODEL,
} from "./gemini.mjs";
import { createRequestLog, ensureGeminiLog } from "./gemini-log.mjs";
import { RESPONSE_SCHEMA, RUBRIC_VERSION, buildRubricRequest, gradeRecord, parseRubricResponse } from "./rubric.mjs";
import { ensureRubricHistory, regradeQueue, replaceGradeStatements, versionRegradeQueue } from "./rubric-history.mjs";
import { ACTIVE, NOT_PORTFOLIO } from "./roster.mjs";
import { PAIR_SCHEMA, buildBatchRequest, buildPairRequest, parseBatchAnswer, parsePairAnswer } from "./compare-prompts.mjs";
import { PAIR_COOLDOWN_DAYS, PROMPT_VERSION_BATCHED, PROMPT_VERSION_ONE_ON_ONE } from "../lib/ranking/config.mjs";
import { planBatches, planPairs, pairKey } from "../lib/ranking/matchmaking.mjs";
import { comparisonsToday, ensureRankingSchema, inputDigest, insertComparison, loadInput, syncVotes, writeResults } from "../lib/ranking/store.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import { ensurePollsSchema, schedulePolls } from "./polls.mjs";
import { contentStage } from "./content/engine.mjs";

export const HUMAN_VOTES_NOTE = "Human votes (the face-off) use no Gemini and are never scheduled; people's grades run all day as they arrive.";

export async function ensureNightSchema(db) {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS night_runs (
        night TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        run_id TEXT,
        summary TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS night_item_failures (
        job TEXT NOT NULL,
        item TEXT NOT NULL,
        nights INTEGER NOT NULL,
        last_night TEXT NOT NULL,
        reason TEXT,
        parked_at TEXT,
        PRIMARY KEY (job, item)
      )`,
    ],
    "write"
  );
}

const iso = (ms) => new Date(ms).toISOString();
const msg = (e) => String(e?.message ?? e).slice(0, 200);
const pacificTime = (at) => {
  const p = pacificParts(at);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Failures across nights
// ---------------------------------------------------------------------------

/**
 * Records that `item` failed tonight. Nights in a row add up; a gap starts
 * over. Returns { nights, parked }.
 */
export async function recordItemFailure(db, { job, item, night, reason, parkAfter, now }) {
  const prev = (await db.execute({ sql: "SELECT nights, last_night FROM night_item_failures WHERE job = ? AND item = ?", args: [job, item] })).rows[0];
  let nights = 1;
  if (prev && String(prev.last_night) === night) nights = Number(prev.nights);
  else if (prev && String(prev.last_night) === previousDay(night)) nights = Number(prev.nights) + 1;
  const parked = nights >= parkAfter;
  await db.execute({
    sql: `INSERT INTO night_item_failures (job, item, nights, last_night, reason, parked_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(job, item) DO UPDATE SET nights = excluded.nights, last_night = excluded.last_night,
            reason = excluded.reason, parked_at = COALESCE(night_item_failures.parked_at, excluded.parked_at)`,
    args: [job, item, nights, night, reason, parked ? iso(now) : null],
  });
  return { nights, parked };
}

const clearItemFailure = (db, job, item) =>
  db.execute({ sql: "DELETE FROM night_item_failures WHERE job = ? AND item = ? AND parked_at IS NULL", args: [job, item] });

/** Every parked item, for the summary and the admin view. */
export async function parkedItems(db) {
  const res = await db.execute("SELECT job, item, nights, reason, parked_at FROM night_item_failures WHERE parked_at IS NOT NULL ORDER BY parked_at DESC, job, item");
  return res.rows.map((r) => ({ job: String(r.job), item: String(r.item), nights: Number(r.nights), reason: r.reason == null ? "" : String(r.reason), parkedAt: String(r.parked_at) }));
}

// ---------------------------------------------------------------------------
// Stage queues
// ---------------------------------------------------------------------------

// Listed, healthy, captured, with the evidence a grade reads (page text and
// facts; pipeline/evidence.mjs measures it on Actions for older rows).
const READY = (p = "p") => `${p}.status = 'live' AND ${p}.shot_key IS NOT NULL AND ${ACTIVE(p)} AND ${p}.page_text IS NOT NULL AND ${p}.facts IS NOT NULL`;
const NOT_PARKED = (job, p = "p") =>
  `NOT EXISTS (SELECT 1 FROM night_item_failures f WHERE f.job = '${job}' AND f.item = ${p}.url AND f.parked_at IS NOT NULL)`;
const NOT_TRIED = (p = "p") => `${p}.url NOT IN (SELECT value FROM json_each(?))`;
const GRADE_COLS = "p.url, p.name, p.shot_key, p.meta, p.ai_rubric, p.page_text, p.facts";
const CHANGED = `json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL
  AND EXISTS (SELECT 1 FROM rating_resets r WHERE r.url = p.url AND r.reason = 'page_changed'
              AND r.at > COALESCE(json_extract(p.ai_rubric, '$.judged_at'), ''))`;

const queues = {
  grade_new: {
    count: async (ctx) => count(ctx.db, `FROM portfolios p WHERE ${READY()} AND p.ai_rubric IS NULL AND ${NOT_PARKED("grade-new")}`),
    next: async (ctx, stage, n) =>
      (
        await ctx.db.execute({
          sql: `SELECT ${GRADE_COLS} FROM portfolios p
                WHERE ${READY()} AND p.ai_rubric IS NULL AND ${NOT_PARKED("grade-new")} AND ${NOT_TRIED()}
                ORDER BY p.needs_review DESC, p.captured_at DESC, p.url LIMIT ?`,
          args: [JSON.stringify(stage.tried), n],
        })
      ).rows.map((row) => ({ id: String(row.url), row })),
  },
  grade_changed: {
    count: async (ctx) => count(ctx.db, `FROM portfolios p WHERE ${READY()} AND ${CHANGED} AND ${NOT_PARKED("grade-changed")}`),
    next: async (ctx, stage, n) =>
      (
        await ctx.db.execute({
          sql: `SELECT ${GRADE_COLS} FROM portfolios p
                WHERE ${READY()} AND ${CHANGED} AND ${NOT_PARKED("grade-changed")} AND ${NOT_TRIED()}
                ORDER BY p.captured_at DESC, p.url LIMIT ?`,
          args: [JSON.stringify(stage.tried), n],
        })
      ).rows.map((row) => ({ id: String(row.url), row })),
  },
  regrade: {
    count: async (ctx) => {
      const old = await count(
        ctx.db,
        `FROM portfolios p WHERE ${READY()} AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL
           AND json_extract(p.ai_rubric, '$.tier') IS NOT NULL AND COALESCE(json_extract(p.ai_rubric, '$.model'), '') != '${PRIMARY_MODEL}'
           AND ${NOT_PARKED("regrade")}`
      );
      if (!ctx.flags.rubricRegrade) return old;
      return (
        old +
        (await count(
          ctx.db,
          `FROM portfolios p WHERE ${READY()} AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL
             AND json_extract(p.ai_rubric, '$.model') = '${PRIMARY_MODEL}' AND COALESCE(json_extract(p.ai_rubric, '$.rubric_version'), 1) < ${RUBRIC_VERSION}
             AND ${NOT_PARKED("regrade")}`
        ))
      );
    },
    next: async (ctx, stage, n) => {
      // rubric-history.mjs queues on the bare table name.
      const where = `AND ${READY("portfolios")} AND ${NOT_PARKED("regrade", "portfolios")} AND ${NOT_TRIED("portfolios")}`;
      const whereArgs = [JSON.stringify(stage.tried)];
      let rows = await regradeQueue(ctx.db, { primary: PRIMARY_MODEL, limit: n, where, whereArgs });
      if (rows.length < n && ctx.flags.rubricRegrade) {
        rows = [...rows, ...(await versionRegradeQueue(ctx.db, { primary: PRIMARY_MODEL, version: RUBRIC_VERSION, limit: n - rows.length, where, whereArgs }))];
      }
      return rows.map((row) => ({ id: String(row.url), row }));
    },
  },
};

async function count(db, from) {
  const res = await db.execute(`SELECT COUNT(*) AS n ${from}`);
  return Number(res.rows[0]?.n ?? 0);
}

// One grade from stored evidence: the R2 hero, the page text and facts.
// Returns "ok", "skipped" (screenshot unavailable for now) or "sentinel"
// (screenshot gone for good). Throws Gemini errors and malformed answers.
async function gradeItem(ctx, gemini, { row }, { replace }) {
  const url = String(row.url);
  const image = await ctx.image(String(row.shot_key));
  if (image === "missing") {
    if (!replace) {
      await ctx.db.execute({
        sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
        args: [JSON.stringify({ error: "no_usable_captures", judged_at: iso(ctx.now()) }), url],
      });
    }
    return "sentinel";
  }
  if (!image) return "skipped";
  const now = new Date(ctx.now());
  const rubric = await gradeFromEvidence(gemini, { row, image, now });
  await ctx.db.batch(replaceGradeStatements(url, row.ai_rubric, rubric, now), "write");
  return "ok";
}

/**
 * A rubric v2 grade from stored evidence (row: url, name, page_text, facts,
 * meta) and the hero image, on 3.5 only. Shared with people's requests
 * (pipeline/people.mjs). Throws Gemini errors and malformed answers.
 */
export async function gradeFromEvidence(gemini, { row, image, now }) {
  const stored = parseJson(row.facts);
  const motion = parseJson(row.meta)?.motion;
  const facts = stored && stored.motion == null && typeof motion === "boolean" ? { ...stored, motion } : stored;
  const request = buildRubricRequest({ name: String(row.name ?? ""), url: String(row.url), pageText: String(row.page_text ?? ""), facts, image, now });
  const { result, model, usage } = await gemini.generate(request.parts, RESPONSE_SCHEMA, request.options);
  if (model !== PRIMARY_MODEL) throw new Error(`answered by ${model}, not ${PRIMARY_MODEL}`);
  return gradeRecord({ parsed: parseRubricResponse(result), model, usage, facts, source: "r2", now });
}

// ---------------------------------------------------------------------------
// The stages
// ---------------------------------------------------------------------------
const handlers = {
  grade_new: { ...queues.grade_new, parkable: true, run: (ctx, g, item) => gradeItem(ctx, g, item, { replace: false }) },
  grade_changed: { ...queues.grade_changed, parkable: true, run: (ctx, g, item) => gradeItem(ctx, g, item, { replace: true }) },
  compare: {
    off: (ctx) => (ctx.flags.rankingV2 ? null : 'off: RANKING_V2 is not "true" (the ELO-era AI votes run only by hand, judge-vote.yml)'),
    count: async (ctx) => {
      const done = await comparisonsToday(ctx.db, { now: new Date(ctx.now()), model: PRIMARY_MODEL });
      return Math.max(0, ctx.flags.ranking.budget.one_on_one - done.one_on_one) + Math.max(0, ctx.flags.ranking.budget.batched - done.batched);
    },
    prepare: prepareComparisons,
    next: async (ctx, stage, n) => stage.plan.slice(stage.cursor, stage.cursor + n).map((job, i) => ({ id: `${stage.seed}#${stage.cursor + i}`, job, index: stage.cursor + i })),
    advance: (stage) => {
      stage.cursor++;
    },
    run: compareItem,
    close: rebuildBoards,
    parkable: false,
  },
  // The weekly polls, then the content engine's posts (pipeline/content/engine.mjs).
  content: contentStage,
  regrade: { ...queues.regrade, parkable: true, run: (ctx, g, item) => gradeItem(ctx, g, item, { replace: true }) },
  experiment: { off: () => "nothing scheduled" },
};

// Plans tonight's comparisons once (the matchmaking needs the current
// ratings), for what the budget allows now.
async function prepareComparisons(ctx, stage, allowed) {
  const { db } = ctx;
  const now = new Date(ctx.now());
  const config = ctx.flags.ranking;
  await syncVotes(db);
  const done = await comparisonsToday(db, { now, model: PRIMARY_MODEL });
  const oneOnOne = Math.min(Math.max(0, config.budget.one_on_one - done.one_on_one), allowed);
  const batched = Math.min(Math.max(0, config.budget.batched - done.batched), allowed - oneOnOne);
  const rows = (
    await db.execute(
      `SELECT url FROM portfolios p WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${ACTIVE("p")} AND NOT ${NOT_PORTFOLIO("p")}`
    )
  ).rows;
  const comparable = new Set(rows.map((r) => String(r.url)));
  const input = await loadInput(db);
  const { boards } = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts, history: false });
  const pool = boards.ai.filter((r) => comparable.has(r.url)).map((r) => ({ url: r.url, mu: r.mu, sigma: r.sigma }));
  const cutoff = iso(now.getTime() - PAIR_COOLDOWN_DAYS * 86400000);
  const aiPairs = input.comparisons.filter((c) => c.rater_type === "ai" && c.method === "one_on_one" && c.ranking);
  const recent = new Set(aiPairs.filter((c) => c.created_at >= cutoff).map((c) => pairKey(c.ranking[0][0], c.ranking[1][0])));
  const past = aiPairs.filter((c) => Array.isArray(c.shown) && c.prompt_version === PROMPT_VERSION_ONE_ON_ONE);
  stage.seed = `${stage.night}:${done.one_on_one}:${done.batched}`;
  const pairs = planPairs({ sites: pool, n: oneOnOne, seed: stage.seed, recent, past });
  const groups = planBatches({ sites: pool, n: batched, size: config.batchSize, seed: stage.seed });
  stage.plan = [...pairs.map((p) => ({ method: "one_on_one", shown: p.shown, kind: p.kind })), ...groups.map((b) => ({ method: "batched", shown: b.shown, kind: b.kind }))];
  stage.cursor = 0;
  ctx.log(`AI ranking comparisons: pool ${pool.length}, planned ${pairs.length} pair(s) and ${groups.length} batch(es), seed ${stage.seed}`);
}

async function compareItem(ctx, gemini, { job, index }, stage) {
  const { db } = ctx;
  const ph = job.shown.map(() => "?").join(",");
  const rows = (await db.execute({ sql: `SELECT url, name, shot_key, page_text FROM portfolios WHERE url IN (${ph})`, args: job.shown })).rows;
  const byUrl = new Map(rows.map((r) => [String(r.url), r]));
  const sites = [];
  for (const url of job.shown) {
    const r = byUrl.get(url);
    const image = r ? await ctx.image(String(r.shot_key)) : null;
    if (!image || image === "missing") return "skipped";
    sites.push({ url, name: String(r.name ?? ""), pageText: r.page_text == null ? "" : String(r.page_text), image });
  }
  const one = job.method === "one_on_one";
  const request = one ? buildPairRequest(sites) : buildBatchRequest(sites);
  const { result, model } = await gemini.generate(request.parts, one ? PAIR_SCHEMA : request.schema, request.options);
  const parsed = one ? parsePairAnswer(result, job.shown) : parseBatchAnswer(result, job.shown);
  await insertComparison(db, {
    created_at: new Date(ctx.now()),
    rater_type: "ai",
    rater_id: `ai:${ctx.flags.ranking.model}`,
    model,
    prompt_version: one ? PROMPT_VERSION_ONE_ON_ONE : PROMPT_VERSION_BATCHED,
    method: job.method,
    shown: job.shown,
    ranking: parsed.ranking,
    outcome: parsed.ranking ? "ranked" : "skip",
    reason: parsed.reason.slice(0, 300),
    match_seed: stage.seed,
    match_kind: job.kind,
    run_id: ctx.runId ?? null,
    experiment: model === PRIMARY_MODEL ? null : "backup-model",
    // Idempotent if a Workflow step runs again.
    source: `ai-night:${stage.seed}:${index}`,
  });
  return "ok";
}

// After the comparisons: the People, AI and Merged boards from every stored
// comparison (scripts/recompute-ratings.mjs does the same by hand). Page
// changes were already recorded by the nightly checks.
async function rebuildBoards(ctx, stage) {
  if (!stage.ok) return;
  const config = ctx.flags.ranking;
  const input = await loadInput(ctx.db);
  const result = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts });
  await writeResults(ctx.db, { ...result, digest: inputDigest(input), config, now: new Date(ctx.now()) });
  stage.boards = "rebuilt";
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Claims tonight. Returns { skip, reason } when tonight's run already
 * started (it never restarts itself), else the first state.
 */
export async function startNight(ctx, { trigger = "cron" } = {}) {
  const { db } = ctx;
  const now = ctx.now();
  const timeline = nightTimeline(now, ctx.plan);
  await ensureGeminiLog(db);
  await ensureNightSchema(db);
  await ensureRubricHistory(db);
  await ensureRankingSchema(db);
  await ensurePollsSchema(db);
  const claimed = await db.execute({
    sql: "INSERT INTO night_runs (night, started_at, status, run_id) VALUES (?, ?, 'running', ?) ON CONFLICT(night) DO NOTHING RETURNING night",
    args: [timeline.night, iso(now), ctx.runId ?? null],
  });
  if (!claimed.rows.length) {
    const prev = (await db.execute({ sql: "SELECT started_at, status, run_id FROM night_runs WHERE night = ?", args: [timeline.night] })).rows[0];
    // The same Workflow instance retrying this step after its claim was
    // written goes on; anything else is a second run the same night.
    const sameRun = ctx.runId && prev && String(prev.run_id) === String(ctx.runId) && String(prev.status) === "running";
    if (!sameRun) {
      return { skip: true, reason: `tonight's run (${timeline.night}) already started at ${prev?.started_at} (${prev?.status}); it never restarts the same night` };
    }
  }
  ctx.log(`night ${timeline.night}: started at ${pacificTime(now)} Pacific (${trigger}); AI work starts by ${pacificTime(timeline.checksDeadline)}, hard stop ${pacificTime(timeline.hardStop)}`);
  return {
    skip: false,
    night: timeline.night,
    trigger,
    startedAt: iso(now),
    timeline,
    checks: null,
    estimate: null,
    aiStartedAt: null,
    stageIndex: 0,
    stage: null,
    stages: [],
    retriesUsed: 0,
    lastRequestAt: null,
    pauses: 0,
    stopped: null,
    status: "running",
    done: false,
  };
}

/**
 * After the free checks: what each stage has waiting and what the budget
 * allows, and so how long the AI part should take at the pace.
 */
export async function planNight(ctx, state) {
  const s = structuredClone(state);
  // Free and first: a poll for this week (and next, when it starts before
  // tomorrow's run), made by code when nothing was written ahead. A failure
  // here never stops the night.
  try {
    const polls = await schedulePolls(ctx);
    s.polls = polls;
    if (polls.made.length) ctx.log(`Polls: made by code for ${polls.made.join(", ")}`);
  } catch (e) {
    s.polls = { error: msg(e) };
    ctx.log(`Polls: scheduling failed: ${msg(e)}`);
  }
  const usage = await usageToday(ctx.db, { now: new Date(ctx.now()), plan: ctx.plan });
  let room = Math.max(0, (ctx.quota[ctx.plan.model] ?? 0) - (usage.byModel[ctx.plan.model] ?? 0) - Math.max(ctx.plan.reserve, ctx.plan.demandFactor * usage.peopleLastHour));
  const perStage = {};
  for (const st of STAGES) {
    const h = handlers[st.key];
    if (h.off?.(ctx) || !h.count) {
      perStage[st.key] = 0;
      continue;
    }
    const waiting = await h.count(ctx);
    const a = backgroundAllowance(st.key, usage, { plan: ctx.plan, quota: ctx.quota });
    const n = Math.min(waiting, a.cap - a.used, room);
    perStage[st.key] = Math.max(0, n);
    room -= perStage[st.key];
  }
  const requests = Object.values(perStage).reduce((a, b) => a + b, 0);
  s.estimate = { requests, minutes: Math.ceil(requests / ctx.rpm), perStage, quotaLeft: (ctx.quota[ctx.plan.model] ?? 0) - (usage.byModel[ctx.plan.model] ?? 0) };
  s.aiStartedAt = iso(ctx.now());
  ctx.log(`night ${s.night}: estimate ${requests} request(s), about ${s.estimate.minutes} min at ${ctx.rpm}/min (${Object.entries(perStage).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  return s;
}

function openStage(ctx, s) {
  const def = STAGES[s.stageIndex];
  const now = ctx.now();
  const cap = ctx.plan.stages[def.key] ?? { cap: 0, minutes: 0 };
  s.stage = {
    key: def.key,
    job: def.job,
    label: def.label,
    night: s.night,
    startedAt: iso(now),
    deadlineAt: iso(Math.min(now + cap.minutes * 60000, Date.parse(s.timeline.hardStop))),
    requests: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    consecutive: 0,
    parked: [],
    tried: [],
    result: null,
  };
  return s.stage;
}

async function closeStage(ctx, s, result) {
  const stage = s.stage;
  if (!stage) return;
  stage.result ??= result;
  stage.finishedAt = iso(ctx.now());
  try {
    await handlers[stage.key].close?.(ctx, stage);
  } catch (e) {
    stage.result += `; rebuilding the boards failed: ${msg(e)}`;
  }
  const { plan, tried, ...kept } = stage;
  s.stages.push({ ...kept, planned: plan ? plan.length : undefined, triedTonight: tried.length });
  s.stage = null;
  s.stageIndex++;
  if (s.stageIndex >= STAGES.length) s.done = true;
}

async function stopRun(ctx, s, reason, status) {
  s.stopped = reason;
  s.status = status;
  if (s.stage) await closeStage(ctx, s, `stopped: ${reason}`);
  s.done = true;
}

/**
 * One batch of the current stage. Returns { state, pauseMs } where pauseMs
 * asks the caller to wait (people are using Gemini right now) before the
 * next batch. Never throws: an unexpected error ends the run as failed.
 */
export async function runBatch(ctx, state) {
  const s = structuredClone(state);
  if (s.done) return { state: s };
  const { plan, db } = ctx;
  try {
    if (ctx.now() >= Date.parse(s.timeline.hardStop)) {
      await stopRun(ctx, s, `hard stop ${plan.stopBeforeResetMinutes} minutes before the quota resets (${pacificTime(s.timeline.hardStop)} Pacific); the rest waits for tomorrow`, "stopped");
      return { state: s };
    }
    // Open the next stage that has work (stages that are off close at once).
    let stage = s.stage;
    while (!stage) {
      if (s.stageIndex >= STAGES.length) {
        s.done = true;
        return { state: s };
      }
      stage = openStage(ctx, s);
      const off = handlers[stage.key].off?.(ctx);
      if (off) {
        await closeStage(ctx, s, off);
        stage = null;
      }
    }
    const h = handlers[stage.key];
    if (ctx.now() >= Date.parse(stage.deadlineAt)) {
      await closeStage(ctx, s, "time cap reached");
      return { state: s };
    }

    // Before every batch: the quota left and people's demand.
    const usage = await usageToday(db, { now: new Date(ctx.now()), plan });
    if (usage.peopleRecent > 0) {
      const pauseMs = plan.pauseMinutes * 60000;
      if (ctx.now() + pauseMs >= Date.parse(stage.deadlineAt)) {
        await closeStage(ctx, s, "time cap reached (paused for people)");
        return { state: s };
      }
      s.pauses++;
      ctx.log(`${stage.label}: people are grading (${usage.peopleRecent} request(s) in the last ${plan.activeMinutes} min); pausing ${plan.pauseMinutes} min`);
      return { state: s, pauseMs };
    }
    const a = backgroundAllowance(stage.key, usage, { plan, quota: ctx.quota });
    if (a.allowed <= 0) {
      if (a.limitedBy === "cap") await closeStage(ctx, s, `cap reached (${a.cap} requests today)`);
      else await stopRun(ctx, s, `only the reserve for people is left (${Math.max(0, a.remaining)} of the quota, reserve ${a.reserve}); the rest waits for tomorrow`, "stopped");
      return { state: s };
    }
    if (h.prepare && !stage.plan) await h.prepare(ctx, stage, a.allowed);

    const budget = Math.min(plan.batch, a.allowed);
    const items = await h.next(ctx, stage, budget);
    if (!items.length) {
      await closeStage(ctx, s, stage.ok || stage.failed || stage.skipped ? "done: nothing left" : "nothing waiting");
      return { state: s };
    }

    const requestLog = createRequestLog({ db, job: stage.job, runId: ctx.runId ?? null });
    const limiter = createLimiter({ rpm: ctx.rpm, lastAt: s.lastRequestAt == null ? null : Date.parse(s.lastRequestAt), now: ctx.now, sleep: ctx.sleep });
    const gemini = createGemini({
      apiKey: ctx.apiKey,
      models: [PRIMARY_MODEL],
      limiter,
      onRequest: (r) => requestLog.record(r),
      onDailyQuota: "stop",
      retryBudget: Math.max(0, plan.retryBudget - s.retriesUsed),
      fetchImpl: ctx.fetchImpl,
      sleep: ctx.sleep,
      now: ctx.now,
      log: ctx.log,
    });
    const spent = () => Object.values(gemini.requests).reduce((x, y) => x + y, 0);
    let stop = null;
    for (const item of items) {
      if (spent() >= budget) break;
      // The deadlines count from when the request would go out, after the pace.
      if (limiter.nextAt >= Date.parse(stage.deadlineAt) || limiter.nextAt >= Date.parse(s.timeline.hardStop)) {
        stage.timeCapped = true;
        break;
      }
      try {
        // left: what this batch may still spend, for an item that makes several requests (a post).
        const out = await h.run(ctx, gemini, item, stage, { left: budget - spent() });
        if (out === "skipped") {
          stage.skipped++;
          stage.tried.push(item.id);
        } else {
          stage.ok++;
          stage.consecutive = 0;
          if (h.parkable) await clearItemFailure(db, stage.job, item.id);
        }
      } catch (e) {
        if (e instanceof GeminiAuthError) {
          stop = ["the Gemini key was rejected (check the GEMINI_API_KEY Worker secret)", "failed"];
          break;
        }
        if (e instanceof GeminiQuotaError) {
          stop = ["3.5's daily quota is spent; the rest waits for tomorrow", "stopped"];
          break;
        }
        if (e instanceof GeminiRetryBudgetError) {
          stop = [`tonight's retry budget (${plan.retryBudget} retries) is used up; the rest waits for tomorrow`, "stopped"];
          break;
        }
        stage.failed++;
        stage.consecutive++;
        stage.tried.push(item.id);
        stage.lastError = msg(e);
        ctx.log(`${stage.label}: ${item.id} failed: ${msg(e)}`);
        // Only the item's own failures count towards parking, never a busy 3.5.
        if (h.parkable && !(e instanceof GeminiUnavailableError)) {
          const f = await recordItemFailure(db, { job: stage.job, item: item.id, night: s.night, reason: msg(e), parkAfter: plan.parkAfterNights, now: ctx.now() });
          if (f.parked) stage.parked.push(item.id);
        }
        if (stage.consecutive >= plan.breaker) break;
      } finally {
        h.advance?.(stage, item);
      }
    }
    stage.requests += spent();
    s.retriesUsed += gemini.counts.retries;
    if (limiter.last != null) s.lastRequestAt = iso(limiter.last);
    if (stop) await stopRun(ctx, s, stop[0], stop[1]);
    else if (stage.consecutive >= plan.breaker) await closeStage(ctx, s, `circuit breaker: ${plan.breaker} failures in a row (last: ${stage.lastError})`);
    else if (stage.timeCapped || ctx.now() >= Date.parse(stage.deadlineAt)) {
      if (ctx.now() + limiter.gap >= Date.parse(s.timeline.hardStop)) {
        await stopRun(ctx, s, `hard stop ${plan.stopBeforeResetMinutes} minutes before the quota resets (${pacificTime(s.timeline.hardStop)} Pacific); the rest waits for tomorrow`, "stopped");
      } else await closeStage(ctx, s, "time cap reached");
    }
    return { state: s };
  } catch (e) {
    ctx.log(`night ${s.night}: unexpected error: ${msg(e)}`);
    await stopRun(ctx, s, `unexpected error: ${msg(e)}`, "failed");
    return { state: s };
  }
}

const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

/**
 * The run's summary (Markdown and JSON), stored in night_runs. Returns
 * { status, markdown, summary }.
 */
export async function finishNight(ctx, state) {
  const s = structuredClone(state);
  const finishedAt = iso(ctx.now());
  // Stages never reached (a stop, or the hard stop) are listed too.
  const seen = new Set(s.stages.map((x) => x.key));
  const stages = [...s.stages, ...STAGES.filter((d) => !seen.has(d.key)).map((d) => ({ key: d.key, label: d.label, requests: 0, ok: 0, failed: 0, skipped: 0, parked: [], result: s.stopped ? "not reached" : "not run" }))];
  const requests = stages.reduce((a, x) => a + (x.requests ?? 0), 0);
  const status = s.status === "running" ? "complete" : s.status;
  const parked = await parkedItems(ctx.db).catch(() => []);
  const summary = {
    night: s.night,
    status,
    stopped: s.stopped,
    startedAt: s.startedAt,
    aiStartedAt: s.aiStartedAt,
    finishedAt,
    checks: s.checks,
    estimate: s.estimate,
    actual: { requests, minutes: s.aiStartedAt ? minutes(s.aiStartedAt, finishedAt) : 0, retries: s.retriesUsed, pauses: s.pauses },
    stages: stages.map((x) => ({ key: x.key, label: x.label, requests: x.requests ?? 0, done: x.ok ?? 0, failed: x.failed ?? 0, skipped: x.skipped ?? 0, parked: x.parked ?? [], minutes: x.startedAt && x.finishedAt ? minutes(x.startedAt, x.finishedAt) : 0, result: x.result ?? "" })),
    parked,
    humanVotes: HUMAN_VOTES_NOTE,
    polls: s.polls ?? null,
  };
  const est = s.estimate ? `${s.estimate.requests} request(s), about ${s.estimate.minutes} min at ${ctx.rpm}/min` : "none (the AI stages never started)";
  const md = [
    `## End-of-day run, ${s.night} (Pacific quota day)`,
    "",
    `Status: **${status}**${s.stopped ? `. Stopped: ${s.stopped}.` : "."}`,
    `Started ${pacificTime(s.startedAt)} Pacific; AI work from ${s.aiStartedAt ? pacificTime(s.aiStartedAt) : "-"} to ${pacificTime(finishedAt)}.`,
    `Estimated: ${est}. Actual: ${requests} request(s) in ${summary.actual.minutes} min, ${s.retriesUsed} retr${s.retriesUsed === 1 ? "y" : "ies"}, ${s.pauses} pause(s) for people.`,
    s.checks ? `Free checks: ${s.checks.summary}` : "",
    "",
    "| Stage | Requests | Done | Failed | Skipped | Minutes | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.stages.map((x) => `| ${x.label} | ${x.requests} | ${x.done} | ${x.failed} | ${x.skipped} | ${x.minutes} | ${x.result} |`),
    "",
    HUMAN_VOTES_NOTE,
    "",
    parked.length
      ? [`Parked (failed on ${ctx.plan.parkAfterNights} nights in a row, not retried until cleared from night_item_failures):`, ...parked.map((p) => `- ${p.job}: ${p.item} (${p.reason})`)].join("\n")
      : "Nothing parked.",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  await ctx.db.execute({
    sql: "UPDATE night_runs SET finished_at = ?, status = ?, summary = ? WHERE night = ?",
    args: [finishedAt, status, JSON.stringify({ ...summary, markdown: md }), s.night],
  });
  ctx.log(md);
  return { status, markdown: md, summary };
}

/** The latest runs, newest first, for the admin view. */
export async function recentNights(db, { limit = 14 } = {}) {
  const res = await db.execute({ sql: "SELECT night, started_at, finished_at, status, summary FROM night_runs ORDER BY night DESC LIMIT ?", args: [limit] });
  return res.rows.map((r) => {
    const summary = parseJson(r.summary);
    if (summary) delete summary.markdown;
    return { night: String(r.night), startedAt: String(r.started_at), finishedAt: r.finished_at == null ? null : String(r.finished_at), status: String(r.status), summary };
  });
}
