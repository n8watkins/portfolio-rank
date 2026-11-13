// The grader's tick (wrangler.jsonc cron "*/5 * * * *"; AUTOMATION.md
// "Grade my portfolio"). It does nothing, and reads nothing, while
// GRADER_ENABLED is not "true". Otherwise, every five minutes:
//
//   1. report emails: one-time links for reports that finished (also after
//      waiting in a queue) to the addresses left for them, through the
//      shared email gate (lib/grader/notify.mjs)
//   2. captures GitHub hasn't started within 10 minutes are dispatched
//      again, at most 3 times (lib/grader/dispatch.mjs)
//   3. requests that waited for a later day's share start, while today's
//      share has room
//   4. once an hour: reports past 180 days are deleted with their
//      screenshots; expired links, old cap counters and stale addresses go
//
// People's grades that waited for Gemini 3.5 are finished by the hourly
// people-queue cron (worker/night.ts drainPeople), which moves their jobs
// along; their emails then go out on the next tick.
import { db as database } from "../lib/db";
import { graderCaps, pruneCaps, reserveSite } from "../lib/grader/caps.mjs";
import { retryStalled, startCapture } from "../lib/grader/dispatch.mjs";
import { deleteJob, expiredJobs, waitingJobs } from "../lib/grader/jobs.mjs";
import { pruneLinks } from "../lib/grader/links.mjs";
import { pruneEmails, sendDueEmails } from "../lib/grader/notify.mjs";
import { createEmailGate, emailCaps, emailTransport } from "../lib/email/gate.mjs";
import { quotaDay } from "../pipeline/quota-day.mjs";
import type { NightEnv } from "./night";
import { siteUrl } from "../lib/site";

export const GRADER_CRON = "*/5 * * * *";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export type GraderEnv = NightEnv & { GRADER_CAPS?: string; EMAIL_CAPS?: string; AUTH_SECRET?: string };

export async function graderTick(env: GraderEnv, scheduledTime = Date.now()) {
  if (!/^true$/i.test(String(env.GRADER_ENABLED ?? ""))) return { skipped: "GRADER_ENABLED is not true" };
  const db = database();
  const now = scheduledTime;
  const secret = env.AUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  const base = siteUrl({ SITE_URL: env.SITE_URL });
  const out: Record<string, unknown> = {};

  const gate = createEmailGate({ db, transport: emailTransport(env, { db }), caps: emailCaps(env.EMAIL_CAPS), secret, log: (line) => log("grader.email", { line }) });
  // With tiers by ELO (RANKING_V2) the email names the tier by ELO, as the report shows it.
  const eloTiers = /^true$/i.test(String((env as { RANKING_V2?: string }).RANKING_V2 ?? ""));
  out.emails = await sendDueEmails(db, { gate, secret, base, now, eloTiers, log: (line: string) => log("grader.email", { line }) });

  const token = env.GITHUB_DISPATCH_TOKEN;
  out.stalled = await retryStalled(db, { token, now, log: (line: string) => log("grader.dispatch", { line }) });

  // Requests that waited for a later day: start them while today's share has room.
  const caps = graderCaps(env.GRADER_CAPS);
  const day = quotaDay(new Date(now)).day;
  let started = 0;
  if (token) {
    for (const id of await waitingJobs(db, { limit: 20 })) {
      if (!(await reserveSite(db, { day, caps }))) break;
      await startCapture(db, id, { token, now, log: (line: string) => log("grader.dispatch", { line }) });
      started++;
    }
  }
  out.waitingStarted = started;

  // Housekeeping, once an hour.
  if (new Date(now).getUTCMinutes() < 5) {
    let deleted = 0;
    for (const job of await expiredJobs(db, { now })) {
      if (job.shotKey?.startsWith("private/grades/")) await env.SHOTS.delete([`${job.shotKey}/hero.jpg`, `${job.shotKey}/mobile.jpg`]);
      if (await deleteJob(db, job.id)) deleted++;
    }
    out.cleanup = { reports: deleted, links: await pruneLinks(db, { now }), caps: await pruneCaps(db, { day }), addresses: await pruneEmails(db, { now }) };
  }
  log("grader.tick", out);
  return out;
}
