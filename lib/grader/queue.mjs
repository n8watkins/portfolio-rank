// Handing a captured job to the people queue for its free-tier grade
// (pipeline/people.mjs): 3.5 Flash-Lite only, within the budget
// accountant's people allowance; when 3.5 is busy or today's quota is used,
// the request waits and the Worker's hourly drain finishes it, and the
// report is emailed. Used by the capture job on GitHub Actions
// (scripts/grade-jobs.mjs) and by the Worker when a visitor switches an
// own-key grade to the free tier.
import { budgetPlan } from "../../pipeline/budget.mjs";
import { dailyQuota } from "../../pipeline/gemini-log.mjs";
import { DEFAULT_RPM } from "../../pipeline/gemini.mjs";
import { requestGrade } from "../../pipeline/people.mjs";
import { setJob } from "./jobs.mjs";
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

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};

/**
 * Queues a captured job's free-tier grade and tries it at once when there
 * is a Gemini key. Returns the job's new status ("done", "queued",
 * "failed" or "grading").
 */
export async function queueFreeGrade(ctx, job) {
  const tryNow = Boolean(ctx.apiKey);
  const facts = job.facts && job.facts.motion == null && typeof job.meta?.motion === "boolean" ? { ...job.facts, motion: job.meta.motion } : job.facts;
  let req;
  try {
    req = await requestGrade(
      ctx,
      {
        kind: "grade",
        url: String(job.final_url ?? job.url),
        name: hostOf(job.url),
        email: null,
        shot_key: String(job.shot_key),
        page_text: String(job.page_text ?? ""),
        facts,
        meta: { grade_job: job.id },
      },
      { tryNow }
    );
  } catch (e) {
    // Our own key was rejected (an owner problem, alerted elsewhere): the
    // request stays queued in people_requests and the drain finishes it.
    ctx.log(`grade ${job.id}: ${String(e?.message ?? e).slice(0, 120)}`);
    await syncFromPeople(ctx.db, { jobId: job.id, request: { status: "queued" }, now: ctx.now() });
    return "queued";
  }
  await setJob(ctx.db, job.id, { people_request_id: Number(req.id) }, { now: ctx.now() });
  if (!tryNow) {
    await syncFromPeople(ctx.db, { jobId: job.id, request: req, now: ctx.now() });
    return "queued";
  }
  return req.status === "done" ? "done" : req.status === "failed" ? "failed" : "queued";
}
