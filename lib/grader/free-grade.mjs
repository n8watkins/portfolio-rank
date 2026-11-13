// The capture job's free-tier grade (scripts/grade-jobs.mjs, on GitHub
// Actions, never a visitor's request): the job goes into the people queue
// (./queue.mjs) and, when there is a Gemini key, is graded at once on 3.5
// Flash-Lite within the budget accountant's people allowance; when 3.5 is
// busy or today's quota is used, the request waits and the Worker's hourly
// drain finishes it, and the report is emailed.
//
// Visitor routes must not import this module (tests/gemini-reach.test.mjs):
// they use ./queue.mjs, which only enqueues.
import { budgetPlan } from "../../pipeline/budget.mjs";
import { dailyQuota, ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { DEFAULT_RPM } from "../../pipeline/gemini.mjs";
import { processRequest, readRequest } from "../../pipeline/people.mjs";
import { enqueueFreeGrade } from "./queue.mjs";
import { syncFromPeople } from "./finish.mjs";

/**
 * The people queue's context (pipeline/night.mjs's shape) from an environment and an image reader.
 *
 * @param {{ db: any, env: Record<string, string | undefined>, image: (shotKey: string) => Promise<unknown>, runId?: string, fetchImpl?: typeof fetch, log?: (line: string) => void }} options
 */
export function peopleContext({ db, env, image, runId = "grader", fetchImpl = (u, i) => fetch(u, i), log = () => {} }) {
  return {
    db,
    apiKey: env.GEMINI_API_KEY || undefined,
    plan: budgetPlan(env.GEMINI_BUDGET),
    quota: dailyQuota(env.GEMINI_DAILY_QUOTA),
    rpm: Number(env.GEMINI_RPM) || DEFAULT_RPM,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    fetchImpl,
    image,
    email: null,
    runId,
  };
}

/**
 * Queues a captured job's free-tier grade and tries it at once when there
 * is a Gemini key. Returns the job's new status ("done", "queued",
 * "failed" or "grading").
 */
export async function queueFreeGrade(ctx, job) {
  const tryNow = Boolean(ctx.apiKey);
  const queued = await enqueueFreeGrade(ctx.db, job, { now: ctx.now(), markQueued: !tryNow });
  if (!tryNow) return "queued";
  await ensureGeminiLog(ctx.db);
  try {
    await processRequest(ctx, queued.requestId);
  } catch (e) {
    // Our own key was rejected (an owner problem, alerted elsewhere): the
    // request stays queued in people_requests and the drain finishes it.
    ctx.log(`grade ${job.id}: ${String(e?.message ?? e).slice(0, 120)}`);
    await syncFromPeople(ctx.db, { jobId: job.id, request: { status: "queued" }, now: ctx.now() });
    return "queued";
  }
  const req = await readRequest(ctx.db, queued.requestId);
  return req.status === "done" ? "done" : req.status === "failed" ? "failed" : "queued";
}
