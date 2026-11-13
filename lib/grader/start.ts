import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { quickFacts } from "@/lib/grader/quick";
import { createJob, countWaiting, readJob, regradeCheck } from "@/lib/grader/jobs.mjs";
import { graderCaps, reserveCaps } from "@/lib/grader/caps.mjs";
import { startCapture } from "@/lib/grader/dispatch.mjs";
import { checkOwnKey } from "@/lib/grader/own-key.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { quotaDay } from "@/pipeline/quota-day.mjs";
import { recordEvent } from "@/lib/games/badges.mjs";
import { gamesEnabled } from "@/lib/games/server";
import { PRIVATE, addOwnedJob, fail, graderFetcher, ownedJobs, requester, testSeam, workerEnv } from "@/lib/grader/server";

// Starting a grade once the request is checked (same origin, a valid
// address, the attempt limits and Turnstile): the free checks, the re-grade
// cooldown, the daily caps and the waiting line, then the job and its
// capture. Shared by POST /api/grade and POST /api/add ("Add your
// portfolio"), so both follow the same rules and caps (lib/grader/caps.mjs).
// Answers what POST /api/grade answers (its comment lists the statuses).

export async function startGrade(
  client: Client,
  { who, target, geminiKey = null, now = Date.now() }: { who: Awaited<ReturnType<typeof requester>>; target: { url: string; siteKey: string }; geminiKey?: string | null; now?: number }
): Promise<NextResponse> {
  // The free checks, at once (cached per address for a day).
  const quick = await quickFacts(client, { url: target.url, siteKey: target.siteKey, fetcher: graderFetcher(), now });
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
