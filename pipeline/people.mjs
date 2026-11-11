// People's grade and re-grade requests (owner decisions 2026-11-10): they
// come first, run as they arrive, and are never graded by a lower model.
//
// "Grade my portfolio" itself (live capture, the report page, Turnstile and
// caps) is phase 4 of the roadmap; this module is the part the budget
// decisions need now, and what that feature calls:
//
//   requestGrade(ctx, input)   queues a request (the capture's evidence:
//                              url, name, shot_key, page_text, facts, meta,
//                              and the person's email) and tries it at once
//   drainPeopleQueue(ctx)      finishes queued requests while 3.5 has quota
//                              for people (the Worker's hourly cron and
//                              requestGrade itself)
//
// A request asks the budget accountant first (peopleAllowance: the whole day
// minus the evening reserve, all of it from 20:30). A busy 3.5 is retried as
// usual (10, 30, 60 s); when it stays busy, or the quota is spent, the
// request stays queued and is finished when 3.5 is available, and the
// person gets an email when it is done. 3.5 only: never a fallback to 3.1.
// Requests are logged as people-grade / people-regrade, which the background
// run watches to pause and to grow its reserve.
//
// ctx is pipeline/night.mjs's context plus `email` (pipeline/alerts.mjs
// sender, or null while no email provider is set up).
//
// "Grade my portfolio" (lib/grader) queues its free-tier grades here with
// meta.grade_job set: after every try the job moves along with the request
// (lib/grader/finish.mjs syncFromPeople), and the report email goes out
// from the grader's own queue (worker/grader.ts), so such requests carry no
// email address here.
import { peopleAllowance, usageToday } from "./budget.mjs";
import { createGemini, createLimiter, GeminiAuthError, GeminiUnavailableError, PRIMARY_MODEL } from "./gemini.mjs";
import { createRequestLog, ensureGeminiLog } from "./gemini-log.mjs";
import { gradeFromEvidence } from "./night.mjs";
import { syncFromPeople } from "../lib/grader/finish.mjs";

export const MAX_ATTEMPTS = 3;

export async function ensurePeopleSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS people_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT,
    email TEXT,
    shot_key TEXT,
    page_text TEXT,
    facts TEXT,
    meta TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT,
    result TEXT,
    notified_at TEXT
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS people_requests_status_idx ON people_requests (status, created_at)");
}

const iso = (ms) => new Date(ms).toISOString();
const msg = (e) => String(e?.message ?? e).slice(0, 200);

/**
 * Queues a request and tries it at once (unless `tryNow` is false: then the
 * hourly drain does). Returns the request row as stored.
 */
export async function requestGrade(ctx, { kind = "grade", url, name = "", email = null, shot_key, page_text, facts, meta = null }, { tryNow = true } = {}) {
  await ensurePeopleSchema(ctx.db);
  await ensureGeminiLog(ctx.db);
  const at = iso(ctx.now());
  const res = await ctx.db.execute({
    sql: `INSERT INTO people_requests (kind, url, name, email, shot_key, page_text, facts, meta, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING id`,
    args: [kind, url, name, email, shot_key, page_text, typeof facts === "string" ? facts : JSON.stringify(facts ?? null), meta == null ? null : typeof meta === "string" ? meta : JSON.stringify(meta), at, at],
  });
  const id = Number(res.rows[0].id);
  if (tryNow) await processRequest(ctx, id);
  return readRequest(ctx.db, id);
}

export async function readRequest(db, id) {
  const r = (await db.execute({ sql: "SELECT * FROM people_requests WHERE id = ?", args: [id] })).rows[0];
  return r ? { ...r, result: r.result ? JSON.parse(String(r.result)) : null } : null;
}

async function setStatus(db, id, fields, now) {
  const keys = Object.keys(fields);
  await db.execute({
    sql: `UPDATE people_requests SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), iso(now), id],
  });
}

/**
 * Tries one queued request. Returns its new status: "done", "queued" (3.5
 * busy, out of quota or the people's share used: it waits) or "failed"
 * (the request itself failed MAX_ATTEMPTS times). A request for a grade job
 * moves its job along too.
 */
export async function processRequest(ctx, id) {
  const status = await processOne(ctx, id);
  if (status) {
    const req = await readRequest(ctx.db, id);
    const jobId = gradeJobOf(req);
    if (jobId) await syncFromPeople(ctx.db, { jobId, request: req, now: ctx.now() });
  }
  return status;
}

/** The grade job a request belongs to (meta.grade_job), or null. */
export function gradeJobOf(req) {
  try {
    const meta = typeof req?.meta === "string" ? JSON.parse(req.meta) : req?.meta;
    return typeof meta?.grade_job === "string" ? meta.grade_job : null;
  } catch {
    return null;
  }
}

async function processOne(ctx, id) {
  const { db } = ctx;
  const req = (await db.execute({ sql: "SELECT * FROM people_requests WHERE id = ? AND status = 'queued'", args: [id] })).rows[0];
  if (!req) return null;
  const usage = await usageToday(db, { now: new Date(ctx.now()), plan: ctx.plan });
  if (peopleAllowance(usage, { plan: ctx.plan, quota: ctx.quota, now: new Date(ctx.now()) }) < 1) {
    await setStatus(db, id, { reason: "today's Gemini quota is used; it runs as soon as there is quota again" }, ctx.now());
    return "queued";
  }
  const image = await ctx.image(String(req.shot_key));
  if (!image || image === "missing") {
    await setStatus(db, id, { reason: "the screenshot isn't available yet; it runs again soon" }, ctx.now());
    return "queued";
  }
  const job = req.kind === "regrade" ? "people-regrade" : "people-grade";
  const requestLog = createRequestLog({ db, job, runId: ctx.runId ?? null });
  const gemini = createGemini({
    apiKey: ctx.apiKey,
    // 3.5 only, for every person's grade: never a lower model.
    models: [PRIMARY_MODEL],
    limiter: createLimiter({ rpm: ctx.rpm, now: ctx.now, sleep: ctx.sleep }),
    onRequest: (r) => requestLog.record(r),
    onDailyQuota: "stop",
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
    now: ctx.now,
    log: ctx.log,
  });
  try {
    const rubric = await gradeFromEvidence(gemini, { row: req, image, now: new Date(ctx.now()) });
    await setStatus(db, id, { status: "done", done_at: iso(ctx.now()), result: JSON.stringify(rubric), reason: null, attempts: Number(req.attempts) + 1 }, ctx.now());
    await notifyPerson(ctx, id);
    return "done";
  } catch (e) {
    if (e instanceof GeminiAuthError) throw e;
    if (e instanceof GeminiUnavailableError) {
      // Busy after the retries, or the daily quota is spent (both are
      // GeminiUnavailableError): it waits for 3.5, never for 3.1.
      await setStatus(db, id, { reason: `waiting for Gemini 3.5: ${msg(e)}` }, ctx.now());
      return "queued";
    }
    const attempts = Number(req.attempts) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await setStatus(db, id, { attempts, status: failed ? "failed" : "queued", reason: msg(e) }, ctx.now());
    return failed ? "failed" : "queued";
  }
}

async function notifyPerson(ctx, id) {
  const req = await readRequest(ctx.db, id);
  if (!req?.email || req.notified_at) return;
  if (!ctx.email) {
    ctx.log(`people request ${id}: done; no email provider is set up, so ${req.kind === "regrade" ? "the re-grade" : "the grade"} wasn't emailed`);
    return;
  }
  await ctx.email.send({
    to: String(req.email),
    subject: `Your PortfolioRank ${req.kind === "regrade" ? "re-grade" : "grade"} is ready`,
    text: `Your portfolio (${req.url}) was graded: tier ${req.result?.tier ?? "?"}.`,
  });
  await setStatus(ctx.db, id, { notified_at: iso(ctx.now()) }, ctx.now());
}

/**
 * Finishes queued requests, oldest first, while there is quota for people.
 * Returns { done, queued, failed }.
 */
export async function drainPeopleQueue(ctx, { limit = 10 } = {}) {
  await ensurePeopleSchema(ctx.db);
  await ensureGeminiLog(ctx.db);
  const ids = (await ctx.db.execute({ sql: "SELECT id FROM people_requests WHERE status = 'queued' ORDER BY created_at, id LIMIT ?", args: [limit] })).rows.map((r) => Number(r.id));
  const out = { done: 0, queued: 0, failed: 0 };
  for (const id of ids) {
    const status = await processRequest(ctx, id);
    if (status) out[status]++;
    // 3.5 is busy or out: the rest waits too.
    if (status === "queued") break;
  }
  return out;
}
