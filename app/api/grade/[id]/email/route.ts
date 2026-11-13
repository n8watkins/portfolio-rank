import { NextResponse } from "next/server";
import { tiersShown } from "@/lib/tiers-view";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";
import { JOB_ID, readJob } from "@/lib/grader/jobs.mjs";
import { emailState, requestEmail, sendDueEmails } from "@/lib/grader/notify.mjs";
import { PRIVATE, authSecret, disabled, emailGate, fail, graderEnabled, readJsonBody, requester, sameOrigin, siteBase } from "@/lib/grader/server";

// "Get it by email, no account needed".
//
// POST /api/grade/<id>/email { email, turnstileToken? }
//   200 { requested: true, sent }: the one-time link goes out when the report
//       is ready (at once if it already is; also after waiting in a queue)
//   400 bad_request | bad_email, 403 bad_origin | turnstile_failed,
//   404 not_found, 409 too_many (2 addresses per report) | unavailable,
//   429 rate_limited
// The address is kept only until its email is sent; every send passes the
// shared email gate's caps (lib/email/gate.mjs), including at most 3 emails
// a day to one address.
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const PER_HOUR = { visitor: 5, ip: 20 };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!graderEnabled()) return disabled();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const { id } = await params;
  if (!JOB_ID.test(id)) return fail("not_found", 404);
  const body = await readJsonBody(req, 4096);
  if (!body) return fail("bad_request", 400);
  await ensureSchema();
  const client = db();
  const job = await readJob(client, id);
  if (!job) return fail("not_found", 404);
  if (job.status === "unavailable") return fail("unavailable", 409, { message: "This grade can't finish right now, so there is nothing to email." });

  const who = await requester(req);
  const now = Date.now();
  const limits = [rateLimit(client, `grade-email:v:${who.visitor}`, { limit: PER_HOUR.visitor, windowMs: HOUR, now })];
  if (who.ip) limits.push(rateLimit(client, `grade-email:ip:${who.network}`, { limit: PER_HOUR.ip, windowMs: HOUR, now }));
  const over = (await Promise.all(limits)).find((h) => !h.ok);
  if (over) return fail("rate_limited", 429, {}, { "retry-after": String(over.retryAfterSec) });
  if ((await verifyTurnstile(body.turnstileToken, who.ip, { action: "grade-email" })) === "failed") return fail("turnstile_failed", 403);

  const r = await requestEmail(client, { jobId: id, email: body.email, secret: authSecret(), now });
  if (!r.ok) return fail(r.error, r.error === "too_many" ? 409 : 400);
  if (job.status === "done" || job.status === "failed") {
    await sendDueEmails(client, { gate: await emailGate(client), secret: authSecret(), base: siteBase(), now, jobId: id, eloTiers: tiersShown() });
  }
  const state = await emailState(client, id);
  return NextResponse.json({ requested: true, sent: state.sent && !state.waiting }, { headers: PRIVATE });
}
