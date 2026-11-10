// Starting a grade's capture on GitHub Actions (owner decision 2026-11-10:
// captures run on Actions, dispatched on demand; Browser Rendering is
// parked). The Worker starts .github/workflows/grade.yml with a
// workflow_dispatch that has no inputs at all: the repository is public, so
// a run's inputs and logs are public, and a job id is the only key to its
// report. The run claims every job waiting for a capture from the database
// (lib/grader/jobs.mjs claimCaptures), so one run serves a burst of
// requests, and a run GitHub cancels while pending (one pending run per
// concurrency group) loses nothing. The visitor's own Gemini key never goes
// to GitHub at all: own-key grades run on the Worker.
//
//   startCapture   after the free checks (and from the cron for requests
//                  that waited for a later day)
//   retryStalled   the cron and the progress endpoint: a capture GitHub
//                  hasn't started within 10 minutes is dispatched again, at
//                  most MAX_DISPATCHES times, then the job fails
import { dispatchWorkflow } from "../../pipeline/github-dispatch.mjs";
import { setJob, stalledCaptures } from "./jobs.mjs";

export const GRADE_WORKFLOW = "grade.yml";
export const MAX_DISPATCHES = 3;
/** A run dispatched this recently, still unclaimed, will pick up a new job too. */
export const COALESCE_MS = 45 * 1000;
export const NO_TOKEN_REASON =
  "Screenshots and the AI grade can't start right now (the capture service isn't connected); the free checks below are ready.";

/**
 * Hands a job's capture to GitHub Actions. Returns the job's new status:
 * "capturing" (dispatched, or riding on a run dispatched moments ago),
 * "unavailable" (no token) or "capturing" with a dispatch error recorded
 * (the cron tries again).
 *
 * @param {any} db
 * @param {string} id
 * @param {{ token?: string, fetchImpl?: typeof fetch, apiBase?: string, now?: number, ref?: string, log?: (line: string) => void }} options
 */
export async function startCapture(db, id, { token, fetchImpl = fetch, apiBase, now = Date.now(), ref = "main", log = () => {} }) {
  if (!token) {
    await setJob(db, id, { status: "unavailable", reason: NO_TOKEN_REASON }, { now });
    return "unavailable";
  }
  await setJob(db, id, { status: "capturing", reason: null }, { now });
  // A run dispatched in the last COALESCE_MS that hasn't claimed yet will claim this job too.
  const recent = (
    await db.execute({
      sql: `SELECT id FROM grade_jobs WHERE status = 'capturing' AND id != ? AND claimed_at IS NULL AND dispatched_at >= ? AND dispatch_run != 'error' LIMIT 1`,
      args: [id, new Date(now - COALESCE_MS).toISOString()],
    })
  ).rows[0];
  if (recent) {
    await db.execute({
      sql: "UPDATE grade_jobs SET dispatched_at = ?, dispatch_attempts = dispatch_attempts + 1, dispatch_run = 'coalesced' WHERE id = ?",
      args: [new Date(now).toISOString(), id],
    });
    return "capturing";
  }
  return dispatch(db, id, { token, fetchImpl, apiBase, now, ref, log });
}

/**
 * @param {any} db
 * @param {string} id
 * @param {{ token: string, fetchImpl: typeof fetch, apiBase?: string, now: number, ref: string, log: (line: string) => void, count?: boolean }} options
 */
async function dispatch(db, id, { token, fetchImpl, apiBase, now, ref, log, count = true }) {
  let run = "error";
  let reason = null;
  try {
    const r = await dispatchWorkflow({ token, workflow: GRADE_WORKFLOW, inputs: {}, ref, fetchImpl, log, ...(apiBase ? { apiBase } : {}) });
    run = "skipped" in r ? "error" : String(r.runId ?? "started");
  } catch (e) {
    // GitHub refused or is down: the cron dispatches again.
    reason = String(e?.message ?? e).slice(0, 200);
    log(`grade capture dispatch failed: ${reason}`);
  }
  await db.execute({
    sql: `UPDATE grade_jobs SET dispatched_at = ?, dispatch_attempts = dispatch_attempts + ${count ? 1 : 0}, dispatch_run = ?, updated_at = ? WHERE id = ?`,
    args: [new Date(now).toISOString(), run, new Date(now).toISOString(), id],
  });
  return "capturing";
}

/**
 * Dispatches captures that GitHub hasn't started within 10 minutes again;
 * after MAX_DISPATCHES the job fails. Returns { redispatched, failed }.
 *
 * @param {any} db
 * @param {{ token?: string, fetchImpl?: typeof fetch, apiBase?: string, now?: number, ref?: string, log?: (line: string) => void, ids?: string[] | null }} options
 */
export async function retryStalled(db, { token, fetchImpl = fetch, apiBase, now = Date.now(), ref = "main", log = () => {}, ids = null }) {
  const out = { redispatched: 0, failed: 0 };
  if (!token) return out;
  let stalled = await stalledCaptures(db, { now });
  if (ids) stalled = stalled.filter((s) => ids.includes(s.id));
  for (const s of stalled) {
    if (s.attempts >= MAX_DISPATCHES) {
      const changed = await setJob(
        db,
        s.id,
        { status: "failed", reason: "The screenshot service didn't start in time. Please try again later." },
        { now, when: ["capturing"] }
      );
      if (changed) out.failed++;
      continue;
    }
    // Claim the retry first (the attempt count moves on), so two isolates never dispatch the same job twice.
    const r = await db.execute({
      sql: "UPDATE grade_jobs SET dispatched_at = ?, dispatch_attempts = dispatch_attempts + 1 WHERE id = ? AND status = 'capturing' AND dispatch_attempts = ?",
      args: [new Date(now).toISOString(), s.id, s.attempts],
    });
    if (!r.rowsAffected) continue;
    await dispatch(db, s.id, { token, fetchImpl, apiBase, now, ref, log, count: false });
    out.redispatched++;
  }
  return out;
}
