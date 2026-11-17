// The grader's housekeeping, run by the five-minute tick (worker/grader.ts):
//
//   recoverStuck   moves jobs that stopped between steps along, so none
//                  stays "grading", "queued", "awaiting_key" or "waiting"
//                  for good (and none blocks its address for good)
//   sweepExpired   deletes reports past the retention period with their
//                  people request, emails and screenshots
//   pruneOrphanRequests  people-queue rows whose report is gone
//
// Plain JavaScript on the database alone (no Gemini), so the tests and the
// Worker share it.
import { readRequest, ensurePeopleSchema } from "../../pipeline/people-store.mjs";
import { PEOPLE_OF_JOB, deleteJob, expiredJobs, readJob, setJob, shotKeyOf } from "./jobs.mjs";
import { enqueueFreeGrade } from "./queue.mjs";
import { syncFromPeople } from "./finish.mjs";

/** A job in "grading" (or "queued") that has made no progress for this long is recovered. */
export const STUCK_GRADING_MS = 30 * 60 * 1000;
/** An own-key grade the visitor's browser never finished expires after this long. */
export const AWAITING_KEY_MS = 3 * 86400000;
/** A request that waited for a later day's share this long is given up on. */
export const WAITING_MS = 3 * 86400000;

const iso = (ms) => new Date(ms).toISOString();

const LIVE = new Set(["queued", "running"]);

/** The newest people-queue row of a job, or null. */
async function requestOf(db, jobId) {
  const r = (await db.execute({ sql: `SELECT id FROM people_requests WHERE ${PEOPLE_OF_JOB} ORDER BY id DESC LIMIT 1`, args: [jobId] })).rows[0];
  return r ? readRequest(db, Number(r.id)) : null;
}

/**
 * Ends or moves along the jobs that stopped. Returns
 * { requeued, failed, expired }: jobs put back in line, jobs failed
 * (visitor-facing reason, and the emails asked for go out on the tick's
 * next email pass) and own-key or waiting jobs that ran out of time.
 *
 * @param {any} db
 * @param {{ now?: number, log?: (line: string) => void }} [options]
 */
export async function recoverStuck(db, { now = Date.now(), log = () => {} } = {}) {
  await ensurePeopleSchema(db);
  const out = { requeued: 0, failed: 0, expired: 0 };

  // Captured, but the free-tier grade never made it into the queue (or its request is gone, failed or done).
  const idle = (
    await db.execute({
      sql: "SELECT id FROM grade_jobs WHERE status IN ('grading', 'queued') AND updated_at < ? ORDER BY updated_at LIMIT 50",
      args: [iso(now - STUCK_GRADING_MS)],
    })
  ).rows;
  for (const { id } of idle) {
    const jobId = String(id);
    const job = await readJob(db, jobId);
    if (!job || !["grading", "queued"].includes(job.status)) continue;
    const req = await requestOf(db, jobId);
    if (req && LIVE.has(String(req.status))) {
      // Waiting for Gemini 3.5 in the queue is fine; a "grading" job just shows it that way.
      if (job.status === "grading" && (await syncFromPeople(db, { jobId, request: { status: "queued" }, now }))) out.requeued++;
      continue;
    }
    if (req && (req.status === "done" || req.status === "failed")) {
      const moved = await syncFromPeople(db, { jobId, request: req, now });
      if (moved === "failed") out.failed++;
      continue;
    }
    // No request at all: a crash between the capture and the queue. The page text is on the job, so it can be queued again.
    if (job.page_text && job.shot_key && job.captured_at) {
      await enqueueFreeGrade(db, job, { now });
      out.requeued++;
      log(`grade job requeued after ${Math.round((now - Date.parse(String(job.updated_at))) / 60000)} minutes without progress`);
      continue;
    }
    if (await setJob(db, jobId, { status: "failed", reason: "The grade stopped before it finished. Please try again." }, { now, when: ["grading", "queued"] })) out.failed++;
  }

  // Captured on the visitor's own key, never finished.
  const keys = (
    await db.execute({
      sql: "SELECT id FROM grade_jobs WHERE status = 'awaiting_key' AND COALESCE(captured_at, created_at) < ? LIMIT 50",
      args: [iso(now - AWAITING_KEY_MS)],
    })
  ).rows;
  for (const { id } of keys) {
    const reason = "This grade was waiting for your own Gemini key and expired. Start a new grade to try again.";
    if (await setJob(db, String(id), { status: "failed", reason }, { now, when: ["awaiting_key"] })) out.expired++;
  }

  // Waiting for a later day's share that never had room.
  const waiting = (await db.execute({ sql: "SELECT id FROM grade_jobs WHERE status = 'waiting' AND created_at < ? LIMIT 50", args: [iso(now - WAITING_MS)] })).rows;
  for (const { id } of waiting) {
    const reason = "Grading stayed full for days, so this one didn't start. Please try again.";
    if (await setJob(db, String(id), { status: "failed", reason }, { now, when: ["waiting"] })) out.expired++;
  }
  return out;
}

/**
 * Deletes reports past the retention period (REPORT_RETENTION_DAYS): the
 * row, its emails and links, its people-queue request, and the screenshots
 * through `deleteShots(shotKeyPrefix)`. Returns how many were deleted.
 *
 * @param {any} db
 * @param {{ now?: number, deleteShots: (shotKey: string) => Promise<void>, limit?: number }} options
 */
export async function sweepExpired(db, { now = Date.now(), deleteShots, limit = 50 }) {
  let deleted = 0;
  for (const job of await expiredJobs(db, { now, limit })) {
    // A capture that landed late can leave shots without a recorded key: the prefix is the job's own.
    await deleteShots(job.shotKey?.startsWith("private/grades/") ? job.shotKey : shotKeyOf(job.id));
    if (await deleteJob(db, job.id)) deleted++;
  }
  return deleted;
}

/** People-queue rows of grade jobs that no longer exist (a delete that raced the capture). Returns how many went. */
export async function pruneOrphanRequests(db) {
  await ensurePeopleSchema(db);
  const r = await db.execute({
    sql: `DELETE FROM people_requests
          WHERE (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.grade_job') END) IS NOT NULL
            AND (CASE WHEN json_valid(meta) THEN json_extract(meta, '$.grade_job') END) NOT IN (SELECT id FROM grade_jobs)`,
    args: [],
  });
  return r.rowsAffected;
}
