// Handing a captured job to the people queue for its free-tier grade, and
// nothing more: the Worker's hourly drain (pipeline/people.mjs
// drainPeopleQueue, worker/night.ts drainPeople) grades it on 3.5
// Flash-Lite within the people allowance, and the report is emailed.
//
// This is what a visitor's request may do ("Use the free tier" on an
// own-key grade, POST /api/grade/<id>/finish): it never imports code that
// calls Gemini, so a visitor can't spend our key (tests/gemini-reach.test.mjs).
// The capture job, which may grade at once, uses ./free-grade.mjs.
import { enqueueRequest } from "../../pipeline/people-store.mjs";
import { setJob } from "./jobs.mjs";
import { syncFromPeople } from "./finish.mjs";

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};

/**
 * Queues a captured job's free-tier grade without trying it. The job moves
 * to "queued" unless `markQueued` is false (the capture job, which tries it
 * at once and moves the job itself). Returns { status: "queued", requestId }.
 * @param {any} db
 * @param {any} job
 * @param {{ now?: number, markQueued?: boolean }} [options]
 */
export async function enqueueFreeGrade(db, job, { now = Date.now(), markQueued = true } = {}) {
  const facts = job.facts && job.facts.motion == null && typeof job.meta?.motion === "boolean" ? { ...job.facts, motion: job.meta.motion } : job.facts;
  const requestId = await enqueueRequest(
    db,
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
    { now }
  );
  await setJob(db, job.id, { people_request_id: requestId }, { now });
  if (markQueued) await syncFromPeople(db, { jobId: job.id, request: { status: "queued" }, now });
  return { status: "queued", requestId };
}
