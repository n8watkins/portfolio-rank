// Finishing a grade job: the capture lands (recordCapture), the grade is
// written with its report (completeJob), and a person's queued request
// (pipeline/people.mjs) moves its job along (syncFromPeople).
import { buildReport, gradedPool } from "./report.mjs";
import { cachedLibraryState } from "../tiers-store.mjs";
import { readJob, setJob } from "./jobs.mjs";
import { siteKeyOf } from "./url.mjs";
import { pageFingerprint } from "../ranking/store.mjs";

/** The capture job's result for one job (scripts/grade-jobs.mjs). Own-key jobs then wait for the visitor's key. */
export async function recordCapture(db, id, { finalUrl, shotKey, pageText, facts, meta, now = Date.now() }) {
  const job = await readJob(db, id);
  if (!job) return null;
  const at = new Date(now).toISOString();
  const status = job.own_key ? "awaiting_key" : "grading";
  await setJob(
    db,
    id,
    {
      status,
      reason: job.own_key ? "Captured. Your browser finishes the grade on your own Gemini key." : null,
      final_url: finalUrl ?? null,
      shot_key: shotKey,
      page_text: pageText ?? "",
      facts: facts ?? null,
      meta: meta ?? null,
      fingerprint: pageFingerprint(meta),
      captured_at: at,
    },
    { now, when: ["capturing"] }
  );
  return status;
}

/** A capture that failed for good (the page didn't load, renders blank, is parked...). */
export async function failCapture(db, id, reason, { now = Date.now() } = {}) {
  return setJob(db, id, { status: "failed", reason: String(reason).slice(0, 300) }, { now, when: ["capturing"] });
}

/**
 * Writes a finished grade and its report (built from the pool of graded
 * portfolios, without the site itself). `grade` is a rubric record
 * (pipeline/rubric.mjs gradeRecord).
 *
 * @param {any} db
 * @param {string} id
 * @param {{ grade: any, now?: number, pool?: any[] | null }} options
 */
export async function completeJob(db, id, { grade, now = Date.now(), pool = null }) {
  const job = await readJob(db, id);
  if (!job) return false;
  const others = pool ?? (await gradedPool(db, { now }));
  // The last refresh's library (ratings from face-offs), unless a test hands in a pool of its own.
  const library = pool ? null : await cachedLibraryState(db, { now });
  const report = buildReport(grade, others, {
    library,
    url: job.url,
    isSelf: (url) => {
      try {
        return siteKeyOf(url) === job.site_key;
      } catch {
        return false;
      }
    },
  });
  return setJob(
    db,
    id,
    { status: "done", reason: null, result: grade, report, model: grade.model ?? null, done_at: new Date(now).toISOString() },
    { now, when: ["grading", "queued", "awaiting_key"] }
  );
}

/**
 * Moves a job along after its people request was tried
 * (pipeline/people.mjs): done -> the report, queued -> waiting for Gemini
 * 3.5 (it is emailed when ready), failed -> failed.
 */
export async function syncFromPeople(db, { jobId, request, now = Date.now() }) {
  if (!jobId || !request) return null;
  if (request.status === "done" && request.result) {
    await completeJob(db, jobId, { grade: request.result, now });
    return "done";
  }
  if (request.status === "queued") {
    await setJob(
      db,
      jobId,
      { status: "queued", reason: "Gemini is busy or today's free quota is used. Your grade runs as soon as it's available, and we email the link if you leave your address." },
      { now, when: ["grading", "queued"] }
    );
    return "queued";
  }
  if (request.status === "failed") {
    await setJob(db, jobId, { status: "failed", reason: "The AI grade failed. Please try again later." }, { now, when: ["grading", "queued"] });
    return "failed";
  }
  return null;
}
