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
//           flags: { rankingV2, ranking (lib/ranking/config),
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
//   1. Grade new sites: listed, captured, ungraded, with page text and facts.
//      A site is graded once and never re-graded automatically (owner,
//      2026-11-21).
//   2. AI ranking comparisons (ranking v2, only when RANKING_V2 is on), then
//      the boards are rebuilt. Human face-off votes use no Gemini and are
//      never scheduled.
//   3. Content: the weekly polls (pipeline/polls.mjs), at most one request a
//      night and two a week, then the content engine (pipeline/content/
//      engine.mjs, docs/CONTENT-ENGINE.md) while CONTENT_MODE is not "off":
//      the week's pick on Sunday, one post a night on the drafting nights
//   4. Image library: no work in the night, only the cap for the library's
//      Gemini checks, which run in the daily run at 23:15 UTC and in the
//      owner's Make now (worker/library.ts, pipeline/content/library-stage.mjs)
//   5. Experiments (none scheduled)
//
// No endless retries: each request has the client's own retries (10, 30,
// 60 s for a busy 3.5), the night has a retry budget (plan.retryBudget), a
// stage stops after plan.breaker failures in a row, an item that failed is
// not tried again the same night, and an item that fails on
// plan.parkAfterNights nights in a row is parked (night_item_failures) and
// listed in the summary instead of retried. A spent quota stops the run as
// planned waiting, never as a failure.
import { NIGHT_TABLES } from "../lib/pipeline-schema.mjs";
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
import { BUSY_WAIT_MINUTES, CONTENT_GEMINI, isBusy, retryClock } from "./content/busy.mjs";
import { RESPONSE_SCHEMA, buildRubricRequest, gradeRecord, parseRubricResponse } from "./rubric.mjs";
import { ensureRubricHistory, parseRubric, replaceGradeStatements } from "./rubric-history.mjs";
import { REGRADE_REQUEST_TABLES } from "../lib/games/schema.mjs";
import { rankForWrite } from "../lib/tiers-store.mjs";
import { FRESH_GRADE_DUE_SQL, ensureReviewSchema, freshGradeDue } from "../lib/reviews/store.mjs";
import { atTheDoor, setAsideCapture, setAsideCaptures, syncReviewRows, withCaptureColumns } from "../lib/reviews/door.mjs";
import { CAPTURED_BEFORE_CHECK_SQL, storedCaptureBlocked } from "../lib/reviews/stored-capture.mjs";
import { AI_WORK, NOT_PORTFOLIO } from "./roster.mjs";
import { PAIR_SCHEMA, buildBatchRequest, buildPairRequest, parseBatchAnswer, parsePairAnswer } from "./compare-prompts.mjs";
import { PAIR_COOLDOWN_DAYS, PROMPT_VERSION_BATCHED, PROMPT_VERSION_ONE_ON_ONE } from "../lib/ranking/config.mjs";
import { planBatches, planPairs, pairKey } from "../lib/ranking/matchmaking.mjs";
import { comparisonsToday, ensureRankingSchema, inputDigest, insertComparison, loadInput, syncVotes, writeResults } from "../lib/ranking/store.mjs";
import { recompute } from "../lib/ranking/views.mjs";
import { ensurePollsSchema, schedulePolls } from "./polls.mjs";
import { contentStage } from "./content/engine.mjs";
import { libraryStage } from "./content/library-stage.mjs";

export const HUMAN_VOTES_NOTE = "Human votes (the face-off) use no Gemini and are never scheduled; people's grades run all day as they arrive.";

export async function ensureNightSchema(db) {
  await db.batch(NIGHT_TABLES, "write");
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

/**
 * Every parked item of a stage that still exists, for the summary, the
 * owner's "parked" alert and the admin view. Rows parked under a removed
 * stage's job (grade-changed, regrade) stay in the table but are never
 * retried, so they are not reported.
 */
export async function parkedItems(db) {
  const jobs = STAGES.map((s) => s.job);
  const res = await db.execute({
    sql: `SELECT job, item, nights, reason, parked_at FROM night_item_failures
          WHERE parked_at IS NOT NULL AND job IN (${jobs.map(() => "?").join(",")})
          ORDER BY parked_at DESC, job, item`,
    args: jobs,
  });
  return res.rows.map((r) => ({ job: String(r.job), item: String(r.item), nights: Number(r.nights), reason: r.reason == null ? "" : String(r.reason), parkedAt: String(r.parked_at) }));
}

// ---------------------------------------------------------------------------
// Stage queues
// ---------------------------------------------------------------------------

// Listed, healthy, captured, with the evidence a grade reads (page text and
// facts; pipeline/evidence.mjs measures it on Actions for older rows).
const READY = (p = "p") => `${p}.status = 'live' AND ${p}.shot_key IS NOT NULL AND ${AI_WORK(p)} AND ${p}.page_text IS NOT NULL AND ${p}.facts IS NOT NULL`;
const NOT_PARKED = (job, p = "p") =>
  `NOT EXISTS (SELECT 1 FROM night_item_failures f WHERE f.job = '${job}' AND f.item = ${p}.url AND f.parked_at IS NOT NULL)`;
const NOT_TRIED = (p = "p") => `${p}.url NOT IN (SELECT value FROM json_each(?))`;
const GRADE_COLS = "p.url, p.name, p.shot_key, p.meta, p.ai_rubric, p.page_text, p.facts, p.signals, p.captured_at";
// A new site's screenshot was missing when its grade was tried: the marker
// (gradeItem) keeps it from being asked for every night, and a capture newer
// than the marker makes it eligible again (audit F4, 2026-11-16).
const MISSING_IMAGE = (p = "p") =>
  `(json_valid(${p}.ai_rubric) AND json_extract(${p}.ai_rubric, '$.error') = 'no_usable_captures')`;
const RECAPTURED = (p = "p") => `COALESCE(datetime(${p}.captured_at) > datetime(json_extract(${p}.ai_rubric, '$.judged_at')), 0)`;
/**
 * Not graded yet: no grade, or a marker older than the site's latest capture: a missing screenshot,
 * or the one fresh grade due after the owner undid or rejected a removal (lib/reviews/store.mjs
 * FRESH_GRADE_DUE), which the bad capture's scores never were.
 */
const UNGRADED = (p = "p") => `(${p}.ai_rubric IS NULL OR ((${MISSING_IMAGE(p)} OR ${FRESH_GRADE_DUE_SQL(p)}) AND ${RECAPTURED(p)}))`;
/**
 * A person asked for a re-grade (regrade_requests, the owner's "Re-grade" action, lib/games/claims.mjs), and
 * the site has been captured again since: the request asks for that capture (site_freshness.forced_at, the
 * nightly refresh's queue), so the grade reads the page as it is now. Graded once, then the request is closed.
 * Nothing re-grades a site on its own (owner, 2026-11-21); only such a request does.
 */
const REQUESTED = (p = "p") =>
  `EXISTS (SELECT 1 FROM regrade_requests q WHERE q.url = ${p}.url AND q.status = 'pending' AND datetime(${p}.captured_at) > datetime(q.requested_at))`;

const queues = {
  // New sites, and re-grades people asked for (first: someone is waiting), in one cap.
  grade_new: {
    count: async (ctx) => count(ctx.db, `FROM portfolios p WHERE ${READY()} AND (${UNGRADED()} OR ${REQUESTED()}) AND ${NOT_PARKED("grade-new")}`),
    next: async (ctx, stage, n) =>
      (
        await ctx.db.execute({
          sql: `SELECT ${GRADE_COLS} FROM portfolios p
                WHERE ${READY()} AND (${UNGRADED()} OR ${REQUESTED()}) AND ${NOT_PARKED("grade-new")} AND ${NOT_TRIED()}
                ORDER BY ${REQUESTED()} DESC, p.needs_review DESC, p.captured_at DESC, p.url LIMIT ?`,
          args: [JSON.stringify(stage.tried), n],
        })
      ).rows.map((row) => ({ id: String(row.url), row })),
  },
};

/** Closes a site's pending re-grade request: `done` once it was graded, `failed` when no screenshot was usable. */
async function closeRegradeRequest(db, url, status, now) {
  await db.execute({ sql: "UPDATE regrade_requests SET status = ?, done_at = ? WHERE url = ? AND status = 'pending'", args: [status, iso(now), url] });
}

async function count(db, from) {
  const res = await db.execute(`SELECT COUNT(*) AS n ${from}`);
  return Number(res.rows[0]?.n ?? 0);
}

// One grade from stored evidence: the R2 hero, the page text and facts.
// Returns { status: "ok", door } (door: what the door did with Gemini's
// answer, lib/reviews/door.mjs), { status: "unusable", aside } (the stored
// capture does not show the site: set aside for a new capture, nothing sent
// to Gemini), "skipped" (screenshot unavailable for now) or "sentinel"
// (screenshot gone for good). Throws Gemini errors and malformed answers.
async function gradeItem(ctx, gemini, item) {
  // Never grade a capture that does not show the site (lib/reviews/stored-capture.mjs); planNight set
  // most of them aside already, this catches the rest before any request. Checked once, here: the door
  // is told so (captureChecked). Rows without captured_at have it read once.
  const row = await withCaptureColumns(ctx.db, item.row);
  const url = String(row.url);
  const blocked = storedCaptureBlocked(row);
  if (blocked) return { status: "unusable", aside: await setAsideCapture(ctx.db, { row, why: blocked, now: new Date(ctx.now()) }) };
  const image = await ctx.image(String(row.shot_key));
  if (image === "missing") {
    if (freshGradeDue(parseJson(row.ai_rubric))) {
      // Waiting for its one fresh grade (lib/reviews/store.mjs FRESH_GRADE_DUE): the marker, and the owner's
      // keep in it, stay; only its time moves, so the site waits for a capture newer than this one.
      await ctx.db.execute({
        sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.judged_at', ?, '$.missing_image_at', ?) WHERE url = ?",
        args: [iso(ctx.now()), iso(ctx.now()), url],
      });
    } else if (parseRubric(row.ai_rubric)) {
      // A re-grade someone asked for, on a site whose new screenshot is gone: its grade stays, and the request
      // is closed as failed (they may ask again), so it is not tried every night.
      await closeRegradeRequest(ctx.db, url, "failed", ctx.now());
    } else {
      await ctx.db.execute({
        sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
        args: [JSON.stringify({ error: "no_usable_captures", judged_at: iso(ctx.now()) }), url],
      });
    }
    return "sentinel";
  }
  if (!image) return "skipped";
  const now = new Date(ctx.now());
  const grade = await gradeFromEvidence(gemini, { row, image, now });
  // "Is it a portfolio" is decided at the door (lib/reviews/door.mjs): the owner's own verdict holds; a
  // "no" is removed by the rule with a record and Undo, or held for the owner. The grade (ranked,
  // lib/tiers-store.mjs; a background write, shown only with RANKING_V2) and its review row are one write.
  const door = await atTheDoor(ctx.db, {
    grade,
    row,
    now,
    autoApply: Boolean(ctx.flags?.reviewAutoApply),
    captureChecked: true,
    gradeStatements: async (g) => replaceGradeStatements(url, row.ai_rubric, await rankForWrite(ctx.db, g, { url, now: ctx.now() }), now),
  });
  // A re-grade someone asked for is answered: they may ask again later.
  await closeRegradeRequest(ctx.db, url, "done", now);
  return { status: "ok", door: { ...door, tier: grade.tier ?? null } };
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
  // sites: each item is a site (its id the URL), logged per request and listed in the summary.
  grade_new: { ...queues.grade_new, parkable: true, sites: true, run: (ctx, g, item) => gradeItem(ctx, g, item) },
  compare: {
    off: (ctx) => (ctx.flags.rankingV2 ? null : 'off: RANKING_V2 is not "true"'),
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
  // The blog's image library, a few house-style illustrations a night (pipeline/content/library-stage.mjs).
  library: libraryStage,
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
      `SELECT url FROM portfolios p WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${AI_WORK("p")} AND NOT ${NOT_PORTFOLIO("p")}`
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
// comparison (scripts/recompute-ratings.mjs does the same by hand).
async function rebuildBoards(ctx, stage) {
  if (!stage.ok) return;
  const config = ctx.flags.ranking;
  const input = await loadInput(ctx.db);
  const result = recompute({ ...input, aiWeight: config.aiWeight, batchedCounts: config.batchedCounts });
  const out = await writeResults(ctx.db, { ...result, digest: inputDigest(input), config, now: new Date(ctx.now()) });
  // Only changed rows are written (docs/COSTS.md section C); the counts show what a night costs in Turso writes.
  ctx.log(`boards: ${out.ratings.written} row(s) written, ${out.ratings.deleted} deleted, ${out.ratings.unchanged} unchanged; history ${out.history.written} written`);
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
  await ensureReviewSchema(db);
  // The owners' re-grade requests "grade new sites" reads (made by the games schema too; safe to repeat).
  await db.batch(REGRADE_REQUEST_TABLES, "write");
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
 * The sites tonight's "grade new" stage will take: the first of its queue, in
 * its own order, up to what the stage may send tonight (the same sizing as
 * planNight's estimate below). An empty set when the stage is off.
 */
async function gradedTonight(ctx) {
  const st = STAGES.find((x) => x.key === "grade_new");
  if (!st || handlers.grade_new.off?.(ctx)) return new Set();
  const usage = await usageToday(ctx.db, { now: new Date(ctx.now()), plan: ctx.plan });
  const room = Math.max(0, (ctx.quota[ctx.plan.model] ?? 0) - (usage.byModel[ctx.plan.model] ?? 0) - Math.max(ctx.plan.reserve, ctx.plan.demandFactor * usage.peopleLastHour));
  const a = backgroundAllowance("grade_new", usage, { plan: ctx.plan, quota: ctx.quota });
  const n = Math.max(0, Math.min(a.cap - a.used, room));
  if (!n) return new Set();
  return new Set((await queues.grade_new.next(ctx, { tried: [] }, n)).map((x) => x.id));
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
  // Free too: bot-walled sites, listed sites whose signals collapsed, and listed
  // addresses that are not a portfolio page by the address alone go to the
  // review queue (lib/reviews/door.mjs). A failure never stops the night.
  try {
    // The sites tonight's grade will take go to the door in minutes: the roster pass leaves them to it, and
    // only them (a backlog beyond tonight's share still gets its row).
    const sent = await syncReviewRows(ctx.db, { now: new Date(ctx.now()), skipUrls: await gradedTonight(ctx) });
    s.addressBrake = sent.addressBrake ?? null;
    if (sent.addressBrake) ctx.log(`Address rule: brake on, removals held for the owner (${sent.addressBrake.why})`);
    await recordSites(ctx, s, "plan", [
      ...sent.botWall.map((url) => ({ url, entries: [["review", { url, why: "bot wall: the capture never got past a bot check" }]] })),
      ...sent.collapsed.map((url) => ({ url, entries: [["review", { url, why: "the portfolio signals collapsed (weekly health check)" }]] })),
      ...sent.address.map((url) => ({ url, entries: [["review", { url, why: "its address is not a portfolio page (the address rule)" }]] })),
    ]);
    if (sent.botWall.length || sent.collapsed.length || sent.address.length) {
      ctx.log(`Review queue: ${sent.botWall.length} bot-walled, ${sent.collapsed.length} collapsed and ${sent.address.length} not-a-portfolio address(es) sent to the Removal rule or the owner`);
    }
  } catch (e) {
    ctx.log(`Review queue: writing the free rows failed: ${msg(e)}`);
  }
  // Free too: sites waiting for a grade whose stored capture does not show the site (captures from
  // before the capture checked its screen, #235) are set aside for a new capture, never sent to Gemini
  // and never removed on its answer (lib/reviews/stored-capture.mjs, door.mjs setAsideCapture).
  try {
    await setAsideUnusable(ctx, s);
  } catch (e) {
    // Said in the summary: the check did not run to the end. Each grade still checks its own site.
    s.storedCaptureCheckFailed = msg(e);
    ctx.log(`Stored captures: checking them failed: ${msg(e)}; each grade still checks its own`);
  }
  // New sites set aside for a missing screenshot: waiting for a newer capture, or back in the queue tonight (audit F4).
  try {
    const marked = `FROM portfolios p WHERE ${READY()} AND ${MISSING_IMAGE()}`;
    s.missingImage = { waiting: await count(ctx.db, `${marked} AND NOT ${RECAPTURED()}`), retried: await count(ctx.db, `${marked} AND ${RECAPTURED()}`) };
  } catch {
    s.missingImage = null;
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

/**
 * The next stage to open, by key: the first stage in STAGES that tonight has
 * not closed yet. A run's state outlives a release (a Workflow resumes from
 * its last step on new code), so the stored stageIndex is never trusted to
 * name a stage: a stage list that changed under a running night still opens
 * every remaining stage once, in order, and never the wrong one. -1 when none is left.
 */
export function nextStageIndex(s) {
  const closed = new Set((s.stages ?? []).map((x) => x.key));
  return STAGES.findIndex((d) => !closed.has(d.key));
}

function openStage(ctx, s) {
  s.stageIndex = nextStageIndex(s);
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
    await handlers[stage.key]?.close?.(ctx, stage);
  } catch (e) {
    stage.result += `; rebuilding the boards failed: ${msg(e)}`;
  }
  const { plan, tried, ...kept } = stage;
  s.stages.push({ ...kept, planned: plan ? plan.length : undefined, triedTonight: tried?.length ?? 0 });
  s.stage = null;
  s.stageIndex = nextStageIndex(s);
  if (s.stageIndex < 0) s.done = true;
}

async function stopRun(ctx, s, reason, status) {
  s.stopped = reason;
  s.status = status;
  if (s.stage) await closeStage(ctx, s, `stopped: ${reason}`);
  s.done = true;
}

/**
 * The sites tonight touched, for the summary (night_runs.summary.sites) and
 * whatever reads it later (a weekly digest): each list holds at most
 * SITE_LIST_MAX entries, and counts holds how many there were in all.
 *   graded    [{ url, stage, verdict, tier }]  every grade written tonight
 *   removed   [{ url, reviewId }]              removed automatically (the door's rule)
 *   review    [{ url, why, reviewId? }]        sent to the owner's review queue
 *   failed    [{ url, stage, reason }]
 *   setAside  [{ url, stage, why }]            a screenshot missing or unavailable
 */
export const SITE_LIST_MAX = 50;
export const SITE_LISTS = ["graded", "removed", "review", "failed", "setAside"];
export const emptySites = () => ({ ...Object.fromEntries(SITE_LISTS.map((k) => [k, []])), counts: Object.fromEntries(SITE_LISTS.map((k) => [k, 0])) });

// Each site's outcome in a stage is also written to night_sites, one row per (night, stage, site)
// holding all of that outcome's list entries, and the summary is read from there (sitesWritten): a
// Workflow step that is retried after its writes starts again from the state before it, so what the
// lost attempt did is in the database, never in the state it returned. The retry works the same
// item again and its row replaces the lost attempt's, so the site's final outcome in that stage
// wins (a failure the retry graded is listed as graded only). The free part writes under stage
// "plan". Bookkeeping only: a failed write is logged and never fails the item or the night.

/** The night's in-memory lists (the fallback when night_sites cannot be read). */
function noteInMemory(s, entries) {
  s.sites ??= emptySites();
  for (const [list, entry] of entries) {
    s.sites.counts[list]++;
    if (s.sites[list].length < SITE_LIST_MAX) s.sites[list].push(entry);
  }
}

/** Records the outcomes of several sites in one stage: `records` is [{ url, entries: [[list, entry]] }]. */
async function recordSites(ctx, s, stage, records) {
  if (!records.length) return;
  for (const r of records) noteInMemory(s, r.entries);
  try {
    await ctx.db.batch(
      records.map((r) => ({
        sql: `INSERT INTO night_sites (night, stage, url, entries, at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(night, stage, url) DO UPDATE SET entries = excluded.entries, at = excluded.at`,
        args: [s.night, stage, r.url, JSON.stringify(r.entries), iso(ctx.now())],
      })),
      "write"
    );
  } catch (e) {
    ctx.log(`night summary: recording ${records.length} site(s) of ${stage} failed: ${msg(e)} (the summary falls back to this attempt's own lists)`);
    s.sitesUnrecorded = (s.sitesUnrecorded ?? 0) + records.length;
  }
}

/**
 * The night's site lists as written (night_sites), in the shape of emptySites, with each stage's
 * tallies from the same rows ({ [stage]: { done, failed, unusable } }) and every unusable-capture
 * reason (uncapped, for the summary); null when they cannot be read.
 */
async function sitesWritten(db, night) {
  let rows;
  try {
    rows = (await db.execute({ sql: "SELECT stage, entries FROM night_sites WHERE night = ? ORDER BY at, rowid", args: [night] })).rows;
  } catch {
    return null;
  }
  const sites = emptySites();
  const stages = {};
  const unusable = [];
  for (const r of rows) {
    const stage = String(r.stage);
    const tally = (stages[stage] ??= { done: 0, failed: 0, unusable: 0 });
    let entries;
    try {
      entries = JSON.parse(String(r.entries));
    } catch {
      continue;
    }
    for (const [list, entry] of entries) {
      if (!SITE_LISTS.includes(list)) continue;
      sites.counts[list]++;
      if (sites[list].length < SITE_LIST_MAX) sites[list].push(entry);
      if (list === "graded") tally.done++;
      if (list === "failed") tally.failed++;
      if (list === "setAside" && entry.capture) {
        tally.unusable++;
        unusable.push(entry.capture);
      }
    }
  }
  return { sites, stages, unusable };
}

/** A site set aside because its stored capture does not show the site (setAsideCapture's result), as list entries. */
function unusableEntries(stage, aside) {
  const how = aside.recapture === "refresh" ? "its grade is kept and a new capture is asked for" : "captured again before any grade";
  return [
    ["setAside", { url: aside.url, stage, capture: aside.why, why: `the stored capture does not show the site (${aside.why}); not sent to Gemini, ${how}` }],
    ...(aside.botWall && aside.reviewId != null ? [["review", { url: aside.url, why: "bot wall: the stored capture shows a bot check, not the site", reviewId: aside.reviewId }]] : []),
  ];
}

/** How many waiting sites one query of the stored-capture check reads. */
export const STORED_CAPTURE_PAGE = 200;

/**
 * Every site waiting for "grade new sites" whose stored capture is from before the capture checked
 * its screen (lib/reviews/stored-capture.mjs), page by page in address order. Calls
 * `onPage(blocked, scanned)` for each page, where blocked is [{ row, why }] for the ones whose capture
 * does not show the site. Writes nothing itself (scripts/stored-capture-dry-run.mjs reads with it).
 * Returns { scanned, blocked }.
 */
export async function scanStoredCaptures(db, { pageSize = STORED_CAPTURE_PAGE, onPage = async () => {} } = {}) {
  let after = "";
  let scanned = 0;
  let blocked = 0;
  for (;;) {
    const rows = (
      await db.execute({
        sql: `SELECT ${GRADE_COLS} FROM portfolios p
              WHERE ${READY()} AND ${UNGRADED()} AND ${NOT_PARKED("grade-new")} AND ${CAPTURED_BEFORE_CHECK_SQL("p")} AND p.url > ?
              ORDER BY p.url LIMIT ?`,
        args: [after, pageSize],
      })
    ).rows;
    if (!rows.length) break;
    scanned += rows.length;
    after = String(rows.at(-1).url);
    const page = rows.map((row) => ({ row, why: storedCaptureBlocked(row) })).filter((x) => x.why);
    blocked += page.length;
    await onPage(page, scanned);
    if (rows.length < pageSize) break;
  }
  return { scanned, blocked };
}

/**
 * planNight's check of every site waiting for "grade new sites": each one whose stored capture does
 * not show the site is set aside (lib/reviews/door.mjs setAsideCaptures), a page at a time, with one
 * write for the page's sites and one for their summary rows.
 */
async function setAsideUnusable(ctx, s) {
  const r = await scanStoredCaptures(ctx.db, {
    onPage: async (page) => {
      if (!page.length) return;
      const asides = await setAsideCaptures(ctx.db, page, { now: new Date(ctx.now()) });
      await recordSites(ctx, s, "plan", asides.map((a) => ({ url: a.url, entries: unusableEntries("plan", a) })));
    },
  });
  if (r.blocked) ctx.log(`Stored captures: ${r.blocked} of ${r.scanned} unchecked capture(s) set aside before grading, their capture does not show the site`);
}

const VERDICT_WORDS = {
  portfolio: "portfolio",
  owner: "the owner's verdict",
  remove: "not a portfolio: removed automatically",
  review: "not a portfolio: waits for the owner (automatic removal is off)",
  strong_signals: "not a portfolio, but the code found a portfolio: kept, sent to review",
  held: "not a portfolio, held for the owner: sent to review",
  owner_kept: "not a portfolio, but the owner kept it: its one fresh grade, kept listed",
};

/** Everything a batch can move on a stage: items done, failed, skipped, set aside, or marked tried. */
export const stageTally = (stage) =>
  (stage.ok ?? 0) + (stage.failed ?? 0) + (stage.skipped ?? 0) + (stage.noImage ?? 0) + (stage.unusable ?? 0) + (stage.tried?.length ?? 0);

/**
 * Whether a batch got anywhere: an item was counted or set aside, or a request
 * was spent. A batch that did neither would be handed the same items again.
 */
export const madeProgress = (tallyBefore, tallyAfter, requestsSpent) => tallyAfter > tallyBefore || requestsSpent > 0;

/**
 * One batch of the current stage. Returns { state, pauseMs, pauseReason? }
 * where pauseMs asks the caller to wait before the next batch: people are
 * using Gemini right now, or (pauseReason "busy") Google's AI was busy on a
 * post and the stage tries it again after the wait. Never throws: an unexpected error ends the run as failed.
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
    // A stage left open by a run that began on older code, and that this code no longer has (a release
    // deployed mid-run), closes as off; the run goes on with the next stage that exists.
    if (s.stage && !handlers[s.stage.key]) {
      await closeStage(ctx, s, "off: this stage was removed by a release during the run");
      if (s.done) return { state: s };
    }
    // Open the next stage that has work (stages that are off close at once).
    let stage = s.stage;
    while (!stage) {
      if (nextStageIndex(s) < 0) {
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
      if (a.limitedBy === "cap") await closeStage(ctx, s, a.cap === 0 ? "off: its cap is 0 (GEMINI_BUDGET turns it on)" : `cap reached (${a.cap} requests today)`);
      else await stopRun(ctx, s, `only the reserve for people is left (${Math.max(0, a.remaining)} of the quota, reserve ${a.reserve}); the rest waits for tomorrow`, "stopped");
      return { state: s };
    }
    if (h.prepare && !stage.plan) await h.prepare(ctx, stage, a.allowed);

    const budget = Math.min(plan.batch, a.allowed);
    const items = await h.next(ctx, stage, budget);
    if (!items.length) {
      await closeStage(ctx, s, stage.ok || stage.failed || stage.skipped || stage.noImage || stage.unusable ? "done: nothing left" : "nothing waiting");
      return { state: s };
    }

    const requestLog = createRequestLog({ db, job: stage.job, runId: ctx.runId ?? null });
    const limiter = createLimiter({ rpm: ctx.rpm, lastAt: s.lastRequestAt == null ? null : Date.parse(s.lastRequestAt), now: ctx.now, sleep: ctx.sleep });
    // A post (the content stage's draft or pick, never the polls) may wait longer and move to
    // 3.1 Flash-Lite while 3.5 is busy (pipeline/content/busy.mjs); everything else stays on 3.5 alone.
    const posts = h.busyRetry && items.every((i) => i.part === "content");
    const gemini = createGemini({
      apiKey: ctx.apiKey,
      models: [PRIMARY_MODEL],
      // A single-site grade (the stages whose items are sites) gives up after plan.requestTimeoutSeconds
      // (60) instead of the client's 120, so one item's four tries fit well inside a batch (audit F9).
      // Comparisons (five sites with images) and posts keep the client's own timeout: there is no latency
      // data to say they finish in 60 s. The batch's wall-clock stop covers every stage.
      ...(posts ? CONTENT_GEMINI : {}),
      ...(h.sites ? { timeoutMs: plan.requestTimeoutSeconds * 1000 } : {}),
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
    const tallyBefore = stageTally(stage);
    let stop = null;
    let busyPauseMs = 0;
    // A batch is one Workflow step, which may run 20 minutes (worker/night.ts ONCE_MORE): it takes no new
    // item after plan.batchMinutes of wall clock and returns normally, so a stalled Gemini (one item can take
    // four timed-out tries plus the retry waits) never kills the night (audit F9). The next batch goes on.
    const batchStartedAt = ctx.now();
    for (const item of items) {
      let later = false;
      if (spent() >= budget) break;
      if (ctx.now() - batchStartedAt >= plan.batchMinutes * 60000) {
        stage.batchCapped = (stage.batchCapped ?? 0) + 1;
        ctx.log(`${stage.label}: the batch ran ${plan.batchMinutes} min; the next batch takes the rest`);
        break;
      }
      // The deadlines count from when the request would go out, after the pace.
      if (limiter.nextAt >= Date.parse(stage.deadlineAt) || limiter.nextAt >= Date.parse(s.timeline.hardStop)) {
        stage.timeCapped = true;
        break;
      }
      // Each request is logged with the site it was for (gemini_requests.item).
      requestLog.item = h.sites ? item.id : null;
      // The item's outcome as list entries for the summary, recorded once whatever happens (finally).
      let notes = null;
      try {
        // left: what this batch may still spend, for an item that makes several requests (a post).
        const res = await h.run(ctx, gemini, item, stage, { left: budget - spent() });
        const out = res && typeof res === "object" ? res.status : res;
        if (out === "skipped") {
          stage.skipped++;
          stage.tried.push(item.id);
          notes = [["setAside", { url: item.id, stage: stage.key, why: "screenshot unavailable for now; tried again tomorrow" }]];
        } else if (out === "sentinel") {
          // No usable image: set aside for tonight, not picked again.
          stage.noImage = (stage.noImage ?? 0) + 1;
          stage.tried.push(item.id);
          notes = [["setAside", { url: item.id, stage: stage.key, why: "screenshot missing; graded after its next capture" }]];
        } else if (out === "unusable") {
          // The stored capture does not show the site: set aside for a new capture, nothing sent to Gemini.
          stage.unusable = (stage.unusable ?? 0) + 1;
          stage.consecutive = 0;
          stage.tried.push(item.id);
          notes = unusableEntries(stage.key, res.aside);
        } else {
          stage.ok++;
          stage.consecutive = 0;
          if (h.parkable) await clearItemFailure(db, stage.job, item.id);
          const door = res && typeof res === "object" ? res.door : null;
          if (door) {
            notes = [["graded", { url: item.id, stage: stage.key, verdict: VERDICT_WORDS[door.outcome] ?? door.outcome, tier: door.tier ?? null }]];
            if (door.outcome === "remove") notes.push(["removed", { url: item.id, reviewId: door.reviewId }]);
            else if (["review", "strong_signals", "held"].includes(door.outcome)) {
              notes.push(["review", { url: item.id, why: VERDICT_WORDS[door.outcome], reviewId: door.reviewId }]);
            }
          }
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
        // Google busy on a post: pause the stage and try the same item again later tonight, up to
        // BUSY_WAIT_MINUTES (15, 20, 30), while the hard stop allows; the pause doesn't eat the stage's time cap.
        const waits = stage.busyWaits ?? 0;
        const pauseMs = (BUSY_WAIT_MINUTES[waits] ?? 0) * 60000;
        if (h.busyRetry && isBusy(e) && pauseMs && ctx.now() + pauseMs + 10 * 60000 < Date.parse(s.timeline.hardStop)) {
          stage.busyWaits = waits + 1;
          stage.deadlineAt = iso(Math.min(Date.parse(stage.deadlineAt) + pauseMs, Date.parse(s.timeline.hardStop)));
          busyPauseMs = pauseMs;
          later = true;
          ctx.log(`${stage.label}: Google's AI is busy (${msg(e)}); retrying at ${retryClock(ctx.now() + pauseMs)} (wait ${waits + 1} of ${BUSY_WAIT_MINUTES.length})`);
          break;
        }
        stage.failed++;
        stage.consecutive++;
        stage.tried.push(item.id);
        stage.lastError = msg(e);
        ctx.log(`${stage.label}: ${item.id} failed: ${msg(e)}`);
        notes = [["failed", { url: item.id, stage: stage.key, reason: msg(e) }]];
        // Only the item's own failures count towards parking, never a busy 3.5.
        if (h.parkable && !(e instanceof GeminiUnavailableError)) {
          const f = await recordItemFailure(db, { job: stage.job, item: item.id, night: s.night, reason: msg(e), parkAfter: plan.parkAfterNights, now: ctx.now() });
          if (f.parked) stage.parked.push(item.id);
        }
        if (stage.consecutive >= plan.breaker) break;
      } finally {
        if (!later) h.advance?.(stage, item);
        if (h.sites && notes) await recordSites(ctx, s, stage.key, [{ url: item.id, entries: notes }]);
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
    } else if (busyPauseMs) return { state: s, pauseMs: busyPauseMs, pauseReason: "busy" };
    // A batch that had items but graded, failed, skipped and spent nothing would get the same
    // items again next time, and the next, until the time cap: the stage ends here instead.
    else if (!madeProgress(tallyBefore, stageTally(stage), spent())) {
      ctx.log(`${stage.label}: a batch of ${items.length} item(s) made no progress; ending the stage`);
      await closeStage(ctx, s, `stopped: a batch made no progress (${items.length} item(s) could not be worked on)`);
    }
    return { state: s };
  } catch (e) {
    ctx.log(`night ${s.night}: unexpected error: ${msg(e)}`);
    await stopRun(ctx, s, `unexpected error: ${msg(e)}`, "failed");
    return { state: s };
  }
}

const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));

/** Gemini requests logged for this run, by job (gemini_requests); empty when they cannot be read. */
async function requestsWritten(ctx, s, finishedAt) {
  const out = {};
  if (ctx.runId == null) return out;
  try {
    const r = await ctx.db.execute({
      sql: "SELECT job, COUNT(*) AS n FROM gemini_requests WHERE run_id = ? AND at >= ? AND at <= ? GROUP BY job",
      args: [String(ctx.runId), s.startedAt, finishedAt],
    });
    for (const row of r.rows) out[String(row.job)] = Number(row.n);
  } catch {
    // The state's own counts stand.
  }
  return out;
}

/** Unusable-capture reasons counted: { count, byWhy }. */
function unusableTally(reasons) {
  const byWhy = {};
  for (const why of reasons) byWhy[why] = (byWhy[why] ?? 0) + 1;
  return { count: reasons.length, byWhy };
}

/**
 * The run's summary (Markdown and JSON), stored in night_runs. Returns
 * { status, markdown, summary }.
 */
export async function finishNight(ctx, state) {
  const s = structuredClone(state);
  // The Workflow's batch limit ran out before the run was done: stopped, not complete (worker/night.ts).
  if (!s.done) await stopRun(ctx, s, "the Workflow's batch limit ran out before every stage finished; the rest waits for tomorrow", "stopped");
  const finishedAt = iso(ctx.now());
  // Stages never reached (a stop, or the hard stop) are listed too.
  const seen = new Set(s.stages.map((x) => x.key));
  const reached = [...s.stages, ...STAGES.filter((d) => !seen.has(d.key)).map((d) => ({ key: d.key, label: d.label, requests: 0, ok: 0, failed: 0, skipped: 0, parked: [], result: s.stopped ? "not reached" : "not run" }))];
  // What was written wins over the state's counts, which miss whatever a retried step's lost attempt did:
  // the site lists and a site stage's done, failed and unusable counts come from night_sites (each
  // site's final outcome in the stage), the requests from gemini_requests.
  const requestsByJob = await requestsWritten(ctx, s, finishedAt);
  const fromDb = await sitesWritten(ctx.db, s.night);
  const sites = fromDb?.sites ?? s.sites ?? emptySites();
  // A note this attempt could not write is in its own lists only: add those, so nothing it did goes missing.
  const unrecorded = Boolean(fromDb && s.sitesUnrecorded);
  if (unrecorded) {
    for (const list of SITE_LISTS) {
      const have = new Set(sites[list].map((x) => x.url));
      const mine = s.sites?.[list] ?? [];
      const extra = mine.filter((x) => !have.has(x.url));
      sites[list].push(...extra.slice(0, Math.max(0, SITE_LIST_MAX - sites[list].length)));
      sites.counts[list] = Math.max(sites.counts[list] + extra.length, s.sites?.counts?.[list] ?? 0);
    }
  }
  const stages = reached.map((x) => {
    const job = STAGES.find((d) => d.key === x.key)?.job;
    const t = fromDb && handlers[x.key]?.sites ? fromDb.stages[x.key] ?? { done: 0, failed: 0, unusable: 0 } : null;
    const pick = (written, own) => (unrecorded ? Math.max(written, own ?? 0) : written);
    return {
      ...x,
      requests: Math.max(x.requests ?? 0, requestsByJob[job] ?? 0),
      ...(t ? { ok: pick(t.done, x.ok), failed: pick(t.failed, x.failed), unusable: pick(t.unusable, x.unusable) } : {}),
    };
  });
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
    stages: stages.map((x) => ({ key: x.key, label: x.label, requests: x.requests ?? 0, done: x.ok ?? 0, failed: x.failed ?? 0, skipped: x.skipped ?? 0, noImage: x.noImage ?? 0, unusable: x.unusable ?? 0, parked: x.parked ?? [], minutes: x.startedAt && x.finishedAt ? minutes(x.startedAt, x.finishedAt) : 0, result: x.result ?? "" })),
    parked,
    humanVotes: HUMAN_VOTES_NOTE,
    polls: s.polls ?? null,
    // The address rule's brake held tonight's removals for the owner (lib/reviews/door.mjs ADDRESS_AUTO_PER_NIGHT).
    addressBrake: s.addressBrake ?? null,
    // The sites tonight touched, as written (night_sites; SITE_LISTS, at most SITE_LIST_MAX each, counts in sites.counts).
    sites,
    // New sites set aside for a missing screenshot: waiting for a newer capture, and back in the queue tonight.
    missingImage: s.missingImage ?? null,
    // Sites set aside before grading because their stored capture does not show the site: how many tonight
    // and why, and whether the free part's check of every waiting site ran to the end (error when not).
    unusableCapture: {
      ...unusableTally(fromDb?.unusable ?? sites.setAside.filter((x) => x.capture).map((x) => x.capture)),
      error: s.storedCaptureCheckFailed ?? null,
    },
    // Sites whose outcome could not be written to night_sites (the lists above then miss them).
    unrecorded: s.sitesUnrecorded ?? 0,
  };
  const siteLines = (title, list, line, note = null) => {
    const n = summary.sites.counts[list];
    if (!n) return [];
    const shown = summary.sites[list];
    return [`### ${title} (${n})`, "", ...(note ? [note, ""] : []), ...shown.map((x) => `- ${line(x)}`), ...(n > shown.length ? [`- and ${n - shown.length} more`] : []), ""];
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
    "| Stage | Requests | Done | Failed | Skipped | Bad capture | Minutes | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.stages.map((x) => `| ${x.label} | ${x.requests} | ${x.done} | ${x.failed} | ${x.skipped} | ${x.unusable} | ${x.minutes} | ${x.result}${x.noImage ? `; ${x.noImage} set aside for a missing image` : ""} |`),
    "",
    HUMAN_VOTES_NOTE,
    "",
    parked.length
      ? [`Parked (failed on ${ctx.plan.parkAfterNights} nights in a row, not retried until cleared from night_item_failures):`, ...parked.map((p) => `- ${p.job}: ${p.item} (${p.reason})`)].join("\n")
      : "Nothing parked.",
    "",
    summary.missingImage && summary.missingImage.waiting + summary.missingImage.retried > 0
      ? `New sites with a missing screenshot: ${summary.missingImage.waiting} waiting for a newer capture, ${summary.missingImage.retried} captured again and back in the queue.\n`
      : "",
    summary.unusableCapture.count
      ? `Set aside before grading, their stored capture does not show the site (never sent to Gemini, never removed; captured again first): ${summary.unusableCapture.count} (${Object.entries(summary.unusableCapture.byWhy).map(([w, n]) => `${n} ${w}`).join("; ")}).\n`
      : "",
    summary.unusableCapture.error
      ? `**The check of stored captures did not finish** (${summary.unusableCapture.error}); each grade still checked its own site before any request.\n`
      : "",
    summary.unrecorded ? `${summary.unrecorded} site outcome(s) could not be recorded; the lists below may miss them.\n` : "",
    ...siteLines("Sites graded", "graded", (x) => `${x.url}: ${x.verdict}${x.tier ? ` (tier ${x.tier})` : ""}${x.stage === "grade_new" ? "" : ` [${x.stage}]`}`),
    ...siteLines("Removed automatically", "removed", (x) => `${x.url}${x.reviewId ? ` (review ${x.reviewId})` : ""}`, "Each one has Undo on /admin/review."),
    ...siteLines("Sent to review", "review", (x) => `${x.url}: ${x.why}`),
    ...siteLines("Failed", "failed", (x) => `${x.url}: ${x.reason}`),
    ...siteLines("Set aside", "setAside", (x) => `${x.url}: ${x.why}`),
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
