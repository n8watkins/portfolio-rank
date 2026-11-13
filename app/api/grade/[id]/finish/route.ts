import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { JOB_ID, readJob, setJob } from "@/lib/grader/jobs.mjs";
import { completeJob } from "@/lib/grader/finish.mjs";
import { gradeOnOwnKey, validOwnKey } from "@/lib/grader/own-key.mjs";
import { enqueueFreeGrade } from "@/lib/grader/queue.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { PRIVATE, disabled, fail, graderEnabled, ownedJobs, readGradeShot, readJsonBody, requester, sameOrigin, testSeam } from "@/lib/grader/server";

// Finishing a grade that runs on the visitor's own Gemini key, once its
// capture has landed (status "awaiting_key").
//
// POST /api/grade/<id>/finish { geminiKey }  -> 200 the job, graded on that
//   key (gemini-3.5-flash-lite, the same rubric, marked ownKey). The key is
//   used for this request only: never stored, never logged, never in a URL
//   or header we receive.
// POST /api/grade/<id>/finish { freeTier: true } -> 202 the job, handed to
//   the free tier instead: it only joins the people queue ("queued"), and
//   the Worker's hourly drain grades it on our key and emails the link.
//   This request never calls Gemini on our key (tests/gemini-reach.test.mjs).
//   400 bad_request | own_key_invalid | own_key_rejected | own_key_quota |
//   grade_failed, 403 bad_origin, 404 not_found, 409 not_waiting_for_key,
//   429 rate_limited, 503 gemini_busy | no_screenshot
// Any visitor with the link may finish it: whoever pays for the request
// is the one sending the key.
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const PER_HOUR = 10;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!graderEnabled()) return disabled();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const { id } = await params;
  if (!JOB_ID.test(id)) return fail("not_found", 404);
  const body = await readJsonBody(req);
  if (!body) return fail("bad_request", 400);
  await ensureSchema();
  const client = db();
  const job = await readJob(client, id);
  if (!job) return fail("not_found", 404);
  if (job.status !== "awaiting_key") return fail("not_waiting_for_key", 409, { status: job.status });

  const who = await requester(req);
  const hit = await rateLimit(client, `grade-finish:v:${who.visitor}`, { limit: PER_HOUR, windowMs: HOUR, now: Date.now() });
  if (!hit.ok) return fail("rate_limited", 429, {}, { "retry-after": String(hit.retryAfterSec) });
  const mine = (await ownedJobs()).includes(id);

  const image = async (shotKey: string) => {
    const bytes = await readGradeShot(shotKey.replace(/\/hero\.jpg$/, ""), "hero.jpg");
    return bytes ? { inline_data: { mime_type: "image/jpeg", data: Buffer.from(bytes).toString("base64") } } : "missing";
  };

  if (body.freeTier === true) {
    const moved = await setJob(client, id, { status: "grading", own_key: false, reason: null }, { when: ["awaiting_key"] });
    if (!moved) return fail("not_waiting_for_key", 409);
    await enqueueFreeGrade(client, (await readJob(client, id))!);
    const queued = (await readJob(client, id))!;
    return NextResponse.json(publicJob(queued, { mine }), { status: 202, headers: PRIVATE });
  }

  const key = typeof body.geminiKey === "string" ? body.geminiKey.trim() : "";
  if (!validOwnKey(key)) return fail("own_key_invalid", 400, { message: "That doesn't look like a Gemini API key." });
  const hero = await image(String(job.shot_key));
  if (hero === "missing") return fail("no_screenshot", 503, { message: "The screenshot isn't available yet. Try again in a minute." });
  const apiBase = testSeam("GRADER_TEST_GEMINI_API");
  const r = await gradeOnOwnKey({ key, job, image: hero, ...(apiBase ? { apiBase } : {}) });
  if (!r.ok) {
    const messages: Record<string, [number, string]> = {
      own_key_rejected: [400, "Google didn't accept that key for gemini-3.5-flash-lite."],
      own_key_quota: [400, "That key's daily Gemini quota is used up. Try again tomorrow, or use the free tier."],
      gemini_busy: [503, "Gemini is busy right now. Try again in a minute."],
      grade_failed: [400, "The grade failed. Try again, or use the free tier."],
    };
    const [status, message] = messages[r.error] ?? [400, "The grade failed."];
    await setJob(client, id, { reason: message }, { when: ["awaiting_key"] });
    return fail(r.error, status, { message });
  }
  await completeJob(client, id, { grade: r.grade });
  const done = (await readJob(client, id))!;
  return NextResponse.json(publicJob(done, { mine }), { headers: PRIVATE });
}
