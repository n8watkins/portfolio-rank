// "Grade my portfolio": what a second visitor gets, what deleting a report
// leaves behind, jobs stuck between steps and how often an open tab asks.
// Offline, on a throwaway database (the same stand-ins as tests/grader.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { createJob, deleteJob, existingReportBody, expiredJobs, readJob, regradeCheck, setJob, shotKeyOf } from "../lib/grader/jobs.mjs";
import { landCapture, recordCapture } from "../lib/grader/finish.mjs";
import { enqueueFreeGrade } from "../lib/grader/queue.mjs";
import { recoverStuck, sweepExpired, STUCK_GRADING_MS, AWAITING_KEY_MS } from "../lib/grader/sweep.mjs";
import { pollDelay } from "../lib/grader/poll.mjs";
import { emailState, requestEmail, sendDueEmails } from "../lib/grader/notify.mjs";
import { budgetPlan } from "../pipeline/budget.mjs";
import { BACKUP_MODEL, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
// A person's own grade still runs on the frozen v2 prompt (pipeline/rubric-v2.mjs).
import { V2_AI_CRITERIA as AI_CRITERIA } from "../pipeline/rubric-v2.mjs";
import { drainPeopleQueue, processRequest } from "../pipeline/people.mjs";
import { readRequest } from "../pipeline/people-store.mjs";

const SECRET = "test-secret-not-real";
const T0 = Date.parse("2026-11-10T20:00:00Z");
const MIN = 60000;
const DAY = 86400000;

async function tempDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grader-visitor-")), "db.sqlite")}`, timeout: 5000 });
  await migrate(db);
  return db;
}

const answer = { is_portfolio: true, tier: "B", ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 3, note: `${c.id} note` }])), roles: ["frontend developer"] };
const gemini200 = (json) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80 } }), { status: 200 });

function peopleCtx(db, { now = T0 } = {}) {
  const calls = [];
  const clock = { t: now };
  return {
    calls,
    clock,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(),
      quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
      rpm: 60,
      now: () => clock.t,
      sleep: async (ms) => void (clock.t += ms),
      log: () => {},
      fetchImpl: async (url) => {
        calls.push(String(url));
        return gemini200(answer);
      },
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      email: null,
      runId: "test",
    },
  };
}

async function captured(db, { siteKey = "jane.dev", now = T0, ownKey = false } = {}) {
  const id = await createJob(db, { url: `https://${siteKey}/`, siteKey, status: "capturing", ownKey, visitor: "v1", now });
  await recordCapture(db, id, { finalUrl: `https://${siteKey}/`, shotKey: shotKeyOf(id), pageText: "Jane builds things. jane@example.com", facts: { github: true }, meta: { motion: true }, now });
  return id;
}

const peopleRows = async (db) => (await db.execute("SELECT * FROM people_requests")).rows;

// ---------------------------------------------------------------------------
// A: everyone is pointed at the existing report
// ---------------------------------------------------------------------------
test("A: the refusal for a cooldown or a running grade carries the report's id, whoever asks", async () => {
  const db = await tempDb();
  const done = await createJob(db, { url: "https://jane.dev/", siteKey: "jane.dev", status: "done", now: T0 });
  await setJob(db, done, { done_at: new Date(T0).toISOString() }, { now: T0 });
  const cool = await regradeCheck(db, { siteKey: "jane.dev", now: T0 + DAY });
  assert.equal(cool.error, "cooldown");
  assert.deepEqual(existingReportBody(cool), { message: cool.reason, nextAt: cool.nextAt, report: done });

  const running = await createJob(db, { url: "https://bob.dev/", siteKey: "bob.dev", status: "grading", now: T0 });
  const busy = await regradeCheck(db, { siteKey: "bob.dev", now: T0 + MIN });
  assert.equal(busy.error, "in_progress");
  assert.equal(existingReportBody(busy).report, running);
  assert.equal(existingReportBody({ allowed: true }), null);
});

// ---------------------------------------------------------------------------
// B: deleting or expiring a report removes the people request and the shots
// ---------------------------------------------------------------------------
test("B: deleting a job deletes its people request (address, page text, result), queued or done", async () => {
  const db = await tempDb();
  const a = await captured(db);
  const b = await captured(db, { siteKey: "bob.dev" });
  await enqueueFreeGrade(db, await readJob(db, a), { now: T0 });
  await enqueueFreeGrade(db, await readJob(db, b), { now: T0 });
  assert.equal((await peopleRows(db)).length, 2);
  assert.ok((await peopleRows(db)).every((r) => String(r.page_text).includes("jane@example.com")));
  assert.equal(await deleteJob(db, a), true);
  const left = await peopleRows(db);
  assert.equal(left.length, 1, "only the other report's request is left");
  assert.equal(JSON.parse(left[0].meta).grade_job, b);
});

test("B: a queued request of a deleted job is never graded, and no Gemini request is spent", async () => {
  const db = await tempDb();
  const id = await captured(db);
  const { requestId } = await enqueueFreeGrade(db, await readJob(db, id), { now: T0 });
  // The row survives (as one a crash left behind, or one added just after the delete): the job is gone.
  await db.execute({ sql: "DELETE FROM grade_jobs WHERE id = ?", args: [id] });
  const { ctx, calls } = peopleCtx(db);
  assert.deepEqual(await drainPeopleQueue(ctx), { done: 0, queued: 0, failed: 0 });
  assert.equal(calls.length, 0);
  assert.equal(await readRequest(db, requestId), null, "the orphan row is removed, not kept");
});

test("B: the retention sweep deletes reports past 180 days with their people request, screenshots and emails, and keeps the rest", async () => {
  const db = await tempDb();
  const old = await captured(db, { now: T0 - 181 * DAY });
  const fresh = await captured(db, { siteKey: "bob.dev", now: T0 - 10 * DAY });
  for (const id of [old, fresh]) await enqueueFreeGrade(db, await readJob(db, id), { now: T0 });
  await requestEmail(db, { jobId: old, email: "old@example.com", secret: SECRET, now: T0 });
  assert.deepEqual((await expiredJobs(db, { now: T0 })).map((j) => j.id), [old]);

  const removed = [];
  const out = await sweepExpired(db, { now: T0, deleteShots: async (key) => void removed.push(key) });
  assert.equal(out, 1);
  assert.deepEqual(removed, [shotKeyOf(old)]);
  assert.equal(await readJob(db, old), null);
  assert.ok(await readJob(db, fresh));
  assert.equal((await emailState(db, old)).requested, false);
  const rows = await peopleRows(db);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].meta).grade_job, fresh);
  assert.equal(await sweepExpired(db, { now: T0, deleteShots: async () => {} }), 0, "nothing more to delete");
});

test("B: a capture that lands after its job was deleted removes what it uploaded and queues nothing", async () => {
  const db = await tempDb();
  const id = await createJob(db, { url: "https://jane.dev/", siteKey: "jane.dev", status: "capturing", now: T0 });
  await deleteJob(db, id);
  const removed = [];
  const status = await landCapture(db, id, { finalUrl: "https://jane.dev/", shotKey: shotKeyOf(id), pageText: "x", facts: {}, meta: {} }, { removeShots: async (key) => void removed.push(key), now: T0 });
  assert.equal(status, null);
  assert.deepEqual(removed, [shotKeyOf(id)]);
  // A capture that lands normally keeps its screenshots.
  const live = await createJob(db, { url: "https://bob.dev/", siteKey: "bob.dev", status: "capturing", now: T0 });
  const kept = [];
  assert.equal(await landCapture(db, live, { finalUrl: "https://bob.dev/", shotKey: shotKeyOf(live), pageText: "x", facts: {}, meta: {} }, { removeShots: async (key) => void kept.push(key), now: T0 }), "grading");
  assert.deepEqual(kept, []);
});

// ---------------------------------------------------------------------------
// C: jobs stuck between steps
// ---------------------------------------------------------------------------
test("C: a job left in grading with no people request is queued again after 30 minutes, and not before", async () => {
  const db = await tempDb();
  const id = await captured(db); // recordCapture ran, enqueueFreeGrade never did
  assert.equal((await readJob(db, id)).status, "grading");
  assert.deepEqual(await recoverStuck(db, { now: T0 + STUCK_GRADING_MS - MIN }), { requeued: 0, failed: 0, expired: 0 });
  assert.equal((await readJob(db, id)).status, "grading");
  const out = await recoverStuck(db, { now: T0 + STUCK_GRADING_MS + MIN });
  assert.equal(out.requeued, 1);
  const job = await readJob(db, id);
  assert.equal(job.status, "queued");
  assert.equal((await peopleRows(db)).length, 1);
  // The drain then grades it.
  const { ctx } = peopleCtx(db, { now: T0 + 3600000 });
  assert.deepEqual(await drainPeopleQueue(ctx), { done: 1, queued: 0, failed: 0 });
  assert.equal((await readJob(db, id)).status, "done");
});

test("C: a job in grading whose request already failed or finished is moved along; one that can't be requeued fails with a message and its email goes out", async () => {
  const db = await tempDb();
  const failedJob = await captured(db, { siteKey: "a.dev" });
  const { requestId } = await enqueueFreeGrade(db, await readJob(db, failedJob), { now: T0, markQueued: false });
  await db.execute({ sql: "UPDATE people_requests SET status = 'failed' WHERE id = ?", args: [requestId] });
  const lost = await captured(db, { siteKey: "b.dev" });
  await db.execute({ sql: "UPDATE grade_jobs SET page_text = NULL, shot_key = NULL WHERE id = ?", args: [lost] });
  await requestEmail(db, { jobId: lost, email: "jane@example.com", secret: SECRET, now: T0 });
  const out = await recoverStuck(db, { now: T0 + STUCK_GRADING_MS + MIN });
  assert.equal(out.failed, 2);
  for (const id of [failedJob, lost]) {
    const j = await readJob(db, id);
    assert.equal(j.status, "failed");
    assert.match(j.reason, /try again/i);
  }
  const sent = [];
  const gate = { send: async (m) => (sent.push(m), { sent: true }) };
  const mail = await sendDueEmails(db, { gate, secret: SECRET, base: "https://example.test", now: T0 + STUCK_GRADING_MS + 2 * MIN });
  assert.equal(mail.sent, 1);
  assert.match(sent[0].subject, /couldn't grade/);
});

test("C: an own-key job that nobody finishes expires after a few days; a recent one stays", async () => {
  const db = await tempDb();
  const stale = await captured(db, { siteKey: "a.dev", ownKey: true, now: T0 });
  const recent = await captured(db, { siteKey: "b.dev", ownKey: true, now: T0 + AWAITING_KEY_MS - DAY });
  assert.equal((await readJob(db, stale)).status, "awaiting_key");
  const out = await recoverStuck(db, { now: T0 + AWAITING_KEY_MS + MIN });
  assert.equal(out.expired, 1);
  const j = await readJob(db, stale);
  assert.equal(j.status, "failed");
  assert.match(j.reason, /own Gemini key/);
  assert.equal((await readJob(db, recent)).status, "awaiting_key");
});

test("C: a stuck job, however old, never lets a duplicate start; once it is recovered and failed, the address can be graded again", async () => {
  const db = await tempDb();
  const id = await captured(db, { now: T0 });
  const later = T0 + 25 * 3600000;
  const check = await regradeCheck(db, { siteKey: "jane.dev", now: later });
  assert.equal(check.allowed, false, "a 25-hour-old grading job still blocks a second job");
  assert.equal(check.jobId, id);
  await setJob(db, id, { status: "failed", reason: "x" }, { now: later });
  assert.equal((await regradeCheck(db, { siteKey: "jane.dev", now: later })).allowed, true);
});

test("C: polling is a few seconds while capturing or grading, minutes while queued or waiting, and paused in a hidden tab", () => {
  assert.ok(pollDelay("capturing") <= 5000);
  assert.ok(pollDelay("grading") <= 5000);
  assert.ok(pollDelay("queued") >= 60000);
  assert.ok(pollDelay("waiting") >= 60000);
  assert.ok(pollDelay("awaiting_key") >= 60000);
  assert.ok(pollDelay("queued", { age: 0 }) <= pollDelay("queued", { age: 3600000 }), "longer waits poll no more often");
  for (const s of ["capturing", "grading", "queued", "waiting"]) assert.equal(pollDelay(s, { hidden: true }), null);
  assert.equal(pollDelay("done"), null);
  // The old rule was 4 s in every state, about 21,600 requests a day for one idle tab.
  const perDay = (ms) => 86400000 / ms;
  assert.ok(perDay(pollDelay("queued")) < 1500);
});

// ---------------------------------------------------------------------------
// D: one claim per people request
// ---------------------------------------------------------------------------
test("D: the drain and the capture runner can't grade the same request at once", async () => {
  const db = await tempDb();
  const id = await captured(db);
  const { requestId } = await enqueueFreeGrade(db, await readJob(db, id), { now: T0 });
  const a = peopleCtx(db);
  const b = peopleCtx(db);
  const [x, y] = await Promise.all([processRequest(a.ctx, requestId), processRequest(b.ctx, requestId)]);
  assert.equal(a.calls.length + b.calls.length, 1, "one Gemini request, not two");
  assert.deepEqual([x, y].filter(Boolean), ["done"]);
  assert.equal((await readJob(db, id)).status, "done");
});

test("D: a claim a crashed run left behind is taken over after a while", async () => {
  const db = await tempDb();
  const id = await captured(db);
  const { requestId } = await enqueueFreeGrade(db, await readJob(db, id), { now: T0 });
  await db.execute({ sql: "UPDATE people_requests SET status = 'running', updated_at = ? WHERE id = ?", args: [new Date(T0).toISOString(), requestId] });
  const soon = peopleCtx(db, { now: T0 + 2 * MIN });
  assert.equal(await processRequest(soon.ctx, requestId), null, "a fresh claim is respected");
  const later = peopleCtx(db, { now: T0 + 30 * MIN });
  assert.equal(await processRequest(later.ctx, requestId), "done");
});
