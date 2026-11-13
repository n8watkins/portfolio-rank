import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { JOB_ID, deleteJob, readJob } from "@/lib/grader/jobs.mjs";
import { retryStalled } from "@/lib/grader/dispatch.mjs";
import { emailState } from "@/lib/grader/notify.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { withEloLetters } from "@/lib/tiers-letters.mjs";
import { tiersShown } from "@/lib/tiers-view";
import { PRIVATE, deleteGradeShots, disabled, fail, graderEnabled, ownedJobs, sameOrigin, testSeam, workerEnv } from "@/lib/grader/server";

// One grade: progress while it runs, then the report.
//
// GET /api/grade/<id> -> the job: { id, url, domain, status, reason, ownKey,
//   mine, steps, checks (the free checks), shots, email: { requested, sent },
//   report: null | { tier, facts, judgments, strengths, fixes, percentile,
//   similar, better, roles, model, ownKey, gradedAt, ... } }
//   Poll it every few seconds while status is capturing, grading or queued.
//   Reports are unlisted: the id is the only way in, every answer says
//   noindex, and nothing is cached in shared caches.
// DELETE /api/grade/<id> -> 204: only the browser that owns the report (it
//   requested it, or opened its emailed one-time link) may delete it; its
//   screenshots go too. 403 not_owner, 404.
export const dynamic = "force-dynamic";

const STALL_MS = 10 * 60 * 1000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!graderEnabled()) return disabled();
  const { id } = await params;
  if (!JOB_ID.test(id)) return fail("not_found", 404);
  await ensureSchema();
  const client = db();
  let job = await readJob(client, id);
  if (!job) return fail("not_found", 404);
  // A capture GitHub hasn't started within 10 minutes is dispatched again while someone watches.
  if (job.status === "capturing" && !job.claimed_at && Date.now() - Date.parse(String(job.dispatched_at ?? job.created_at)) > STALL_MS) {
    const env = await workerEnv();
    const apiBase = testSeam("GRADER_TEST_GITHUB_API");
    await retryStalled(client, { token: typeof env.GITHUB_DISPATCH_TOKEN === "string" ? env.GITHUB_DISPATCH_TOKEN : undefined, ids: [id], ...(apiBase ? { apiBase } : {}) });
    job = (await readJob(client, id)) ?? job;
  }
  const [owned, emails] = await Promise.all([ownedJobs(), emailState(client, id)]);
  const plain = publicJob(job, { mine: owned.includes(id), emails });
  // The letter is the tier by ELO while RANKING_V2 is on (lib/tiers-letters.mjs), as the report page shows it.
  const answer = tiersShown() ? await withEloLetters(db(), plain, job) : plain;
  return NextResponse.json(answer, { headers: PRIVATE });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!graderEnabled()) return disabled();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const { id } = await params;
  if (!JOB_ID.test(id)) return fail("not_found", 404);
  await ensureSchema();
  const client = db();
  const job = await readJob(client, id);
  if (!job) return fail("not_found", 404);
  if (!(await ownedJobs()).includes(id)) return fail("not_owner", 403);
  await deleteGradeShots(job.shot_key == null ? null : String(job.shot_key));
  await deleteJob(client, id);
  return new NextResponse(null, { status: 204, headers: PRIVATE });
}
