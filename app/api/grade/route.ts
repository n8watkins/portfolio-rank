import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeGradeUrl } from "@/lib/grader/url.mjs";
import { quickFacts } from "@/lib/grader/quick";
import { listedSite } from "@/lib/me";
import { createJob, countWaiting, readJob, regradeCheck } from "@/lib/grader/jobs.mjs";
import { graderCaps, reserveCaps } from "@/lib/grader/caps.mjs";
import { startCapture } from "@/lib/grader/dispatch.mjs";
import { checkOwnKey, validOwnKey } from "@/lib/grader/own-key.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { quotaDay } from "@/pipeline/quota-day.mjs";
import { recordEvent } from "@/lib/games/badges.mjs";
import { gamesEnabled } from "@/lib/games/server";
import {
  PRIVATE,
  addOwnedJob,
  disabled,
  fail,
  graderEnabled,
  graderFetcher,
  ownedJobs,
  readJsonBody,
  requester,
  sameOrigin,
  testSeam,
  workerEnv,
} from "@/lib/grader/server";

// "Grade my portfolio": start a grade (AUTOMATION.md "Grade my portfolio").
//
// POST /api/grade { url, turnstileToken?, geminiKey? }
//   202 { id, status, ...the job (GET /api/grade/<id>) }: the free checks are
//       done and in the answer; the screenshot and AI grade run on GitHub
//       Actions ("capturing"), wait for a later day ("waiting", past today's
//       share; the report is emailed), or can't start ("unavailable", no
//       dispatch token)
//   400 bad_request | <address error> (with a message) | own_key_invalid |
//       own_key_rejected
//   403 bad_origin | turnstile_failed
//   404 not_found (the feature is off: GRADER_ENABLED)
//   409 in_progress | cooldown { nextAt, report? (only for its owner) }
//   422 <page error> { checks }: the page can't be graded (unreachable, an
//       HTTP error, parked, not a web page); nothing is counted
//   429 rate_limited (Retry-After) | daily_limit { scope, resetAt }
//   503 busy: too many requests already wait for a later day
//
// geminiKey (optional) is the visitor's own Gemini key: checked here with a
// free metadata call, never stored or logged; the grade then waits for the
// browser to send it once more (POST /api/grade/<id>/finish).
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
/** Attempts (valid or not) per visitor and per IP an hour, before any work is done. */
const ATTEMPTS_PER_HOUR = { visitor: 20, ip: 60 };

export async function POST(req: Request) {
  if (!graderEnabled()) return disabled();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const body = await readJsonBody(req);
  if (!body) return fail("bad_request", 400);
  const target = normalizeGradeUrl(body.url);
  if (!target.ok) return fail(target.error, 400, { message: target.message });
  const geminiKey = typeof body.geminiKey === "string" && body.geminiKey.trim() ? body.geminiKey.trim() : null;
  if (geminiKey !== null && !validOwnKey(geminiKey)) return fail("own_key_invalid", 400, { message: "That doesn't look like a Gemini API key." });

  await ensureSchema();
  const client = db();
  const who = await requester(req);
  const now = Date.now();
  const limits = [rateLimit(client, `grade:v:${who.visitor}`, { limit: ATTEMPTS_PER_HOUR.visitor, windowMs: HOUR, now })];
  if (who.ip) limits.push(rateLimit(client, `grade:ip:${who.network}`, { limit: ATTEMPTS_PER_HOUR.ip, windowMs: HOUR, now }));
  const over = (await Promise.all(limits)).find((h) => !h.ok);
  if (over) return fail("rate_limited", 429, {}, { "retry-after": String(over.retryAfterSec) });

  if ((await verifyTurnstile(body.turnstileToken, who.ip, { action: "grade" })) === "failed") return fail("turnstile_failed", 403);

  // The free checks, at once: the page is fetched again (its fingerprint is
  // what the cooldown compares), its link checks reused while it is
  // unchanged, a failure reused for 10 minutes (lib/grader/quick.ts).
  const quick = await quickFacts(client, { url: target.url, siteKey: target.siteKey, fetcher: graderFetcher(), now, listedUrl: listedSite(target.siteKey)?.url ?? null });
  if (!quick.ok) {
    const { cached, ...checks } = quick;
    void cached;
    return fail(quick.error ?? "unreachable", 422, { message: quick.message, checks });
  }

  const again = await regradeCheck(client, { siteKey: target.siteKey, quickFingerprint: quick.fingerprint ?? null, now });
  if (!again.allowed) {
    const mine = again.jobId && (await ownedJobs()).includes(again.jobId);
    return fail(again.error!, 409, { message: again.reason, nextAt: again.nextAt, ...(mine ? { report: again.jobId } : {}) });
  }

  const caps = graderCaps(process.env.GRADER_CAPS);
  // Signed-in GitHub accounts at least 30 days old may use the whole day's share; anyone else the open part (lib/grader/caps.mjs).
  const mine = { visitor: who.visitor, network: who.network, network48: who.network48, trusted: who.trusted, now: new Date(now), caps };
  let reserved = await reserveCaps(client, mine);
  let waiting = false;
  if (!reserved.ok && reserved.scope === "site") {
    // Past today's share: the request waits for a later day (it still counts for the visitor and the network).
    // The line is short, and one network holds only a couple of places in it.
    const busy = () => fail("busy", 503, { message: "Grading is full for now. Please try again tomorrow." }, { "retry-after": "3600" });
    if ((await countWaiting(client)) >= caps.waiting) return busy();
    if (who.network && (await countWaiting(client, { network: who.network })) >= caps.waitingPerNetwork) return busy();
    reserved = await reserveCaps(client, { ...mine, site: false });
    waiting = reserved.ok;
  }
  if (!reserved.ok) {
    const resetAt = quotaDay(new Date(now)).end.toISOString();
    return fail("daily_limit", 429, { scope: reserved.scope, resetAt, message: "That's today's limit of grades. It resets at midnight Pacific time." });
  }

  // The visitor's own Gemini key is checked with Google only now, after the
  // free checks and the caps: a key check costs a grade from the day's
  // allowance, so this can't be used to test keys in bulk.
  if (geminiKey) {
    const apiBase = testSeam("GRADER_TEST_GEMINI_API");
    const check = await checkOwnKey(geminiKey, apiBase ? { apiBase } : {});
    if (check === "rejected") return fail("own_key_rejected", 400, { message: "Google didn't accept that key for gemini-3.5-flash-lite." });
  }

  const { cached, ...stored } = quick;
  void cached;
  const id = await createJob(client, {
    url: target.url,
    siteKey: target.siteKey,
    status: waiting ? "waiting" : "capturing",
    reason: waiting ? "Today's grading is full. Yours starts tomorrow; leave your email and we send the link when it's ready." : null,
    ownKey: Boolean(geminiKey),
    visitor: who.visitor,
    network: who.network || null,
    quick: stored,
    quickFingerprint: quick.fingerprint ?? null,
    now,
  });
  if (!waiting) {
    const env = await workerEnv();
    const apiBase = testSeam("GRADER_TEST_GITHUB_API");
    await startCapture(client, id, {
      token: typeof env.GITHUB_DISPATCH_TOKEN === "string" ? env.GITHUB_DISPATCH_TOKEN : undefined,
      now,
      ...(apiBase ? { apiBase } : {}),
      log: (line: string) => console.log(JSON.stringify({ event: "grade.dispatch", line: line.slice(0, 200) })),
    });
  }
  await addOwnedJob(id);
  // An accepted request counts toward the games' grade badges (First grade, 10 grades).
  if (gamesEnabled()) await recordEvent(client, who.player, "grade");
  const job = await readJob(client, id);
  return NextResponse.json(publicJob(job, { mine: true }), { status: 202, headers: PRIVATE });
}
