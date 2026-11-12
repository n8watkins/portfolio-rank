// "Write a draft now" (docs/CONTENT-ENGINE.md, "Write a draft now"): the
// owner's draft on demand, run by the DraftWorkflow (worker/draft.ts) from a
// content_jobs row (lib/content/jobs.mjs). The same writer, research,
// images and checks as the night (pipeline/content/engine.mjs runDraft),
// with these caps:
//
//   Gemini    at most MANUAL_REQUESTS a draft, and never more than the
//             "content" job may spend today after the reserve kept for
//             people (pipeline/budget.mjs backgroundAllowance): people's
//             grading is never starved;
//   Tavily    10 a post (TAVILY_PER_POST), inside the week's 50 and the
//             month's 200 (lib/content/tavily-credits.mjs);
//   Pexels    2 a post; Workers AI 1 fresh illustration a post, inside the
//             day's 40 (lib/content/neurons.mjs);
//   drafts    5 a Pacific day, new and rewrites together (MANUAL_PER_DAY).
//
// A manual draft is always stored as a draft, whatever CONTENT_MODE says:
// it never publishes on its own. It is recorded in content_runs as step
// "manual", which the night's schedule does not count.
import crypto from "node:crypto";
import { DEFAULT_RPM, PRIMARY_MODEL, createGemini, createLimiter } from "../gemini.mjs";
import { createRequestLog, dailyQuota, ensureGeminiLog } from "../gemini-log.mjs";
import { backgroundAllowance, budgetPlan, usageToday } from "../budget.mjs";
import { BUILDERS, KIND_LABELS } from "./facts.mjs";
import { PHASES, runDraft } from "./engine.mjs";
import { STAGED_REQUESTS } from "./staged.mjs";
import { finishJob, getJob, setPhase, startJob } from "../../lib/content/jobs.mjs";
import { writerGuidelines } from "../../lib/content/guidelines.mjs";

/** Gemini requests one manual draft may spend at most (a draft that passes first time uses about 9). */
export const MANUAL_REQUESTS = 20;
/** The fewest requests a draft needs to start (the staged writer and two checks). */
export const MANUAL_MIN = STAGED_REQUESTS + 2;

export { PHASES };

const msg = (e) => String(e?.message ?? e).slice(0, 300);

/** A new job id: 16 hex digits. */
export const newJobId = () => crypto.randomBytes(8).toString("hex");

/**
 * The story kind a manual draft uses: the one asked for when it is ready,
 * else the ready kind with the oldest latest post (so drafts spread over the
 * kinds). Returns { kind, sheet } or { error } when no kind is ready.
 */
export async function chooseKind(db, { kind = null, now }) {
  if (kind && BUILDERS[kind]) {
    const sheet = await BUILDERS[kind](db, { now });
    if (sheet.ready) return { kind, sheet };
    return { error: `"${KIND_LABELS[kind] ?? kind}" has no data yet: ${sheet.reason}` };
  }
  const last = new Map((await db.execute("SELECT kind, MAX(created_at) AS at FROM posts GROUP BY kind")).rows.map((r) => [String(r.kind), String(r.at)]));
  const ready = [];
  const waiting = [];
  for (const [k, build] of Object.entries(BUILDERS)) {
    const sheet = await build(db, { now });
    if (sheet.ready) ready.push({ kind: k, sheet, at: last.get(k) ?? "" });
    else waiting.push(`${KIND_LABELS[k] ?? k}: ${sheet.reason}`);
  }
  if (!ready.length) return { error: `no story has enough data yet (${waiting.join("; ")})` };
  ready.sort((a, b) => a.at.localeCompare(b.at) || Object.keys(BUILDERS).indexOf(a.kind) - Object.keys(BUILDERS).indexOf(b.kind));
  return { kind: ready[0].kind, sheet: ready[0].sheet };
}

/**
 * How many Gemini requests a manual draft may spend now: { allowed,
 * remaining, reserve } from the budget accountant, capped at MANUAL_REQUESTS.
 */
export async function manualBudget(db, { env = {}, now = new Date() } = {}) {
  await ensureGeminiLog(db);
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const usage = await usageToday(db, { now: new Date(now), plan });
  const a = backgroundAllowance("content", usage, { plan, quota: dailyQuota(env.GEMINI_DAILY_QUOTA) });
  return { allowed: Math.min(MANUAL_REQUESTS, a.allowed), remaining: a.remaining, reserve: a.reserve, used: a.used, cap: a.cap, limitedBy: a.limitedBy };
}

/**
 * Runs one queued job to the end. `ctx` is the night's engine context
 * (worker/night.ts engine): { db, apiKey, rpm, now, log, fetchImpl, flags,
 * content, env }. Never throws: every outcome ends in the job's row.
 * Returns the finished job.
 */
export async function runManualJob(ctx, jobId) {
  const db = ctx.db;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const job = await getJob(db, jobId);
  if (!job) return null;
  if (!(await startJob(db, jobId, { now: new Date(now()) }))) return job;
  const done = async (status, message, extra = {}) => {
    await finishJob(db, jobId, { status, message, now: new Date(now()), ...extra });
    return getJob(db, jobId);
  };
  try {
    if (!ctx.apiKey) return done("failed", "No GEMINI_API_KEY on this Worker, so there is no writer here.");
    // A rewrite keeps the kind and the angle of the draft it rewrites.
    let source = null;
    if (job.rewriteOf) {
      const r = await db.execute({ sql: "SELECT id, kind, title, json_extract(facts, '$.focus') AS focus FROM posts WHERE id = ?", args: [job.rewriteOf] });
      source = r.rows[0] ?? null;
      if (!source) return done("failed", "The draft to rewrite no longer exists.");
    }
    const picked = await chooseKind(db, { kind: source ? String(source.kind) : job.kind, now: now() });
    if (picked.error) return done("skipped", picked.error);
    const budget = await manualBudget(db, { env: ctx.env ?? {}, now: new Date(now()) });
    if (budget.allowed < MANUAL_MIN) {
      const why = budget.limitedBy === "cap" ? `the content job's ${budget.cap} requests today are used` : `${Math.max(0, budget.remaining)} Gemini requests are left today and ${budget.reserve} are kept for people's grades`;
      return done("skipped", `Not enough Gemini left for a draft now: ${why}. Try again tomorrow.`, { kind: picked.kind });
    }
    await setPhase(db, jobId, { phase: "facts", kind: picked.kind, message: `${KIND_LABELS[picked.kind] ?? picked.kind}, up to ${budget.allowed} Gemini requests` });
    const requestLog = createRequestLog({ db, job: "content", runId: `manual:${jobId}` });
    const gemini = createGemini({
      apiKey: ctx.apiKey,
      models: [PRIMARY_MODEL],
      limiter: createLimiter({ rpm: ctx.rpm || DEFAULT_RPM, now }),
      onRequest: (r) => requestLog.record(r),
      onDailyQuota: "stop",
      // A few retries for a busy API, counted inside the same daily quota; no more.
      retryBudget: 3,
      fetchImpl: ctx.fetchImpl,
      now,
    });
    const guidelines = await writerGuidelines(db);
    const focus = job.topic ?? (source?.focus ? String(source.focus) : null);
    const runCtx = { ...ctx, flags: { ...ctx.flags, contentMode: "dry-run" }, night: `manual-${job.day}` };
    const r = await runDraft(runCtx, gemini, {
      kind: picked.kind,
      night: `manual-${job.day}`,
      budget: budget.allowed,
      step: "manual",
      focus,
      extras: { guidelines, ...(job.notes ? { ownerNotes: job.notes } : {}), ...(job.rewriteOf ? { rewriteOf: job.rewriteOf } : {}) },
      onPhase: (phase, detail) => setPhase(db, jobId, { phase, message: detail ?? null }),
    });
    const spent = { gemini: r.requests ?? 0, tavily: r.searches ?? 0, imagesAi: r.aiImages ?? 0, kind: picked.kind, postId: r.postId ?? null };
    if (r.status === "ok") return done("done", "Done: the draft is waiting for your review.", spent);
    if (r.status === "dropped") return done("dropped", `The draft failed its checks after the revisions and was kept as dropped: ${(r.failures ?? []).slice(0, 3).join("; ")}`, spent);
    if (r.status === "deferred") return done("skipped", "Not enough Gemini budget left to start the draft.", spent);
    return done("skipped", "The story had no data to write from.", spent);
  } catch (e) {
    return done("failed", `Stopped: ${msg(e)}`);
  }
}
