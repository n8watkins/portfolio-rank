// "Grade my portfolio" jobs (AUTOMATION.md "Grade my portfolio"): one row in
// grade_jobs per request, from the free checks to the finished report.
// Plain JavaScript so the Worker's routes, its cron (worker/grader.ts), the
// GitHub Actions job (scripts/grade-jobs.mjs) and the tests share it.
//
// States (status):
//   capturing     the free checks are done; the capture was handed to GitHub
//                 Actions (grade.yml) and waits to be claimed and run
//   waiting       past today's site-wide share: the capture starts when a
//                 later day has room (worker/grader.ts), and the report is
//                 emailed when ready
//   unavailable   captures can't start (no GITHUB_DISPATCH_TOKEN): the free
//                 checks are the whole answer for now
//   grading       captured; the AI grade runs (free tier, 3.5 only)
//   queued        Gemini 3.5 was busy or today's quota is spent: the people
//                 queue finishes it (pipeline/people.mjs) and the report is
//                 emailed
//   awaiting_key  captured, on the visitor's own Gemini key: the visitor's
//                 browser sends the key once to finish it (never stored)
//   done          the report is ready
//   failed        the page couldn't be captured or graded
import { regradeAllowed, REGRADE_COOLDOWN_DAYS } from "../../pipeline/budget.mjs";

export const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
export const ACTIVE_STATES = ["capturing", "waiting", "grading", "queued", "awaiting_key"];
/** A claimed capture that hasn't landed after this long is given to another run. */
export const CLAIM_TTL_MS = 20 * 60 * 1000;
/** Reports (rows and screenshots) are deleted after this many days. */
export const REPORT_RETENTION_DAYS = 180;

const iso = (ms) => new Date(ms).toISOString();

/** 128 random bits as 22 URL-safe characters: the report's link is its only key. */
export function newJobId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a job's screenshots live in the SHOTS bucket: a private prefix the public /shots route never serves. */
export const shotKeyOf = (id) => `private/grades/${id}`;

const parse = (v) => {
  if (v == null || v === "") return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

/**
 * A job row with its JSON columns parsed, or null.
 * @param {any} db
 * @param {unknown} id
 * @returns {Promise<any>}
 */
export async function readJob(db, id) {
  if (!JOB_ID.test(String(id ?? ""))) return null;
  const r = (await db.execute({ sql: "SELECT * FROM grade_jobs WHERE id = ?", args: [id] })).rows[0];
  if (!r) return null;
  return {
    ...r,
    own_key: Number(r.own_key) === 1,
    quick: parse(r.quick),
    facts: parse(r.facts),
    meta: parse(r.meta),
    result: parse(r.result),
    report: parse(r.report),
    dispatch_attempts: Number(r.dispatch_attempts ?? 0),
  };
}

/**
 * @param {any} db
 * @param {{ id?: string, url: string, siteKey: string, status: string, reason?: string | null, ownKey?: boolean, visitor?: string | null, network?: string | null, quick?: object | null, quickFingerprint?: string | null, now?: number }} job
 */
export async function createJob(db, { id = newJobId(), url, siteKey, status, reason = null, ownKey = false, visitor = null, network = null, quick = null, quickFingerprint = null, now = Date.now() }) {
  const at = iso(now);
  await db.execute({
    sql: `INSERT INTO grade_jobs (id, url, site_key, status, reason, own_key, visitor, network, quick, quick_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, url, siteKey, status, reason, ownKey ? 1 : 0, visitor, network, quick ? JSON.stringify(quick) : null, quickFingerprint, at, at],
  });
  return id;
}

/**
 * Updates fields of a job (JSON-encodes objects). `when` adds a guard: only rows whose status is one of these.
 * @param {any} db
 * @param {string} id
 * @param {Record<string, unknown>} fields
 * @param {{ now?: number, when?: string[] | null }} [options]
 */
export async function setJob(db, id, fields, { now = Date.now(), when = null } = {}) {
  const keys = Object.keys(fields);
  const vals = keys.map((k) => {
    const v = fields[k];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  const guard = when ? ` AND status IN (${when.map(() => "?").join(", ")})` : "";
  const r = await db.execute({
    sql: `UPDATE grade_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?${guard}`,
    args: [...vals, iso(now), id, ...(when ?? [])],
  });
  return r.rowsAffected > 0;
}

/**
 * May this site be graded now? Grading a listed site reuses nothing, but
 * the same address is graded at most once every REGRADE_COOLDOWN_DAYS,
 * sooner when the page changed since (its quick fingerprint from the free
 * checks differs), and never twice at the same time.
 * Returns { allowed: true } or { allowed: false, reason, error, nextAt, jobId }.
 *
 * @param {any} db
 * @param {{ siteKey: string, quickFingerprint?: string | null, now?: number }} options
 * @returns {Promise<{ allowed: true, error?: undefined, reason?: undefined, nextAt?: undefined, jobId?: undefined } | { allowed: false, error: string, reason: string, nextAt: string | null, jobId: string }>}
 */
export async function regradeCheck(db, { siteKey, quickFingerprint = null, now = Date.now() }) {
  const rows = (
    await db.execute({
      sql: `SELECT id, status, quick_fingerprint, created_at, done_at FROM grade_jobs
            WHERE site_key = ? AND (status = 'done' OR (status IN (${ACTIVE_STATES.map(() => "?").join(", ")}) AND created_at >= ?))
            ORDER BY created_at DESC LIMIT 5`,
      args: [siteKey, ...ACTIVE_STATES, iso(now - 86400000)],
    })
  ).rows;
  const running = rows.find((r) => ACTIVE_STATES.includes(String(r.status)));
  if (running) return { allowed: false, error: "in_progress", reason: "This address is being graded right now.", nextAt: null, jobId: String(running.id) };
  const last = rows.find((r) => r.status === "done");
  if (!last) return { allowed: true };
  const changed = quickFingerprint && last.quick_fingerprint && quickFingerprint !== last.quick_fingerprint;
  const r = regradeAllowed({ lastGradedAt: String(last.done_at ?? last.created_at), pageChangedAt: changed ? iso(now) : null, now: new Date(now) });
  if (r.allowed) return { allowed: true };
  return { allowed: false, error: "cooldown", reason: `An address is graded at most once every ${REGRADE_COOLDOWN_DAYS} days, sooner when the page changes.`, nextAt: r.nextAt, jobId: String(last.id) };
}

/**
 * The capture job's claim (scripts/grade-jobs.mjs): takes up to `limit`
 * jobs waiting for a capture, oldest first, that no other run holds (a
 * claim older than CLAIM_TTL_MS is taken over). Atomic: two runs never
 * capture the same job.
 */
export async function claimCaptures(db, { runId, limit = 3, now = Date.now() }) {
  const at = iso(now);
  const res = await db.execute({
    sql: `UPDATE grade_jobs SET claimed_at = ?, claim_run = ?, updated_at = ?
          WHERE id IN (SELECT id FROM grade_jobs WHERE status = 'capturing' AND (claimed_at IS NULL OR claimed_at < ?)
                       ORDER BY created_at, id LIMIT ?)
          RETURNING id, url, own_key`,
    args: [at, String(runId), at, iso(now - CLAIM_TTL_MS), limit],
  });
  return res.rows.map((r) => ({ id: String(r.id), url: String(r.url), ownKey: Number(r.own_key) === 1 }));
}

/** Jobs whose capture was handed to GitHub but never claimed (or whose claim went stale). */
export async function stalledCaptures(db, { olderThanMs = 10 * 60 * 1000, now = Date.now(), limit = 10 }) {
  const before = iso(now - olderThanMs);
  const res = await db.execute({
    sql: `SELECT id, dispatch_attempts FROM grade_jobs
          WHERE status = 'capturing' AND COALESCE(dispatched_at, created_at) < ?
            AND (claimed_at IS NULL OR claimed_at < ?)
          ORDER BY created_at LIMIT ?`,
    args: [before, iso(now - CLAIM_TTL_MS), limit],
  });
  return res.rows.map((r) => ({ id: String(r.id), attempts: Number(r.dispatch_attempts ?? 0) }));
}

/** Requests that wait for a later day's share, oldest first. */
export async function waitingJobs(db, { limit = 20 } = {}) {
  const res = await db.execute({ sql: "SELECT id FROM grade_jobs WHERE status = 'waiting' ORDER BY created_at, id LIMIT ?", args: [limit] });
  return res.rows.map((r) => String(r.id));
}

/** Requests waiting for a later day: all of them, or one network's (its keyed id). */
export async function countWaiting(db, { network } = {}) {
  const r = network
    ? await db.execute({ sql: "SELECT COUNT(*) AS n FROM grade_jobs WHERE status = 'waiting' AND network = ?", args: [network] })
    : await db.execute("SELECT COUNT(*) AS n FROM grade_jobs WHERE status = 'waiting'");
  return Number(r.rows[0]?.n ?? 0);
}

/** Jobs past the retention period, oldest first (their screenshots go too). */
export async function expiredJobs(db, { now = Date.now(), days = REPORT_RETENTION_DAYS, limit = 50 } = {}) {
  const res = await db.execute({
    sql: "SELECT id, shot_key FROM grade_jobs WHERE created_at < ? ORDER BY created_at LIMIT ?",
    args: [iso(now - days * 86400000), limit],
  });
  return res.rows.map((r) => ({ id: String(r.id), shotKey: r.shot_key == null ? null : String(r.shot_key) }));
}

/** Deletes a job and everything that points at it (emails, links). Returns true when it existed. */
export async function deleteJob(db, id) {
  const res = await db.batch(
    [
      { sql: "DELETE FROM grade_emails WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM grade_links WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM grade_jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
  return res[2].rowsAffected > 0;
}

/** The progress steps the /grade page shows, from a job's status. */
export function progressSteps(job) {
  const s = job.status;
  const checks = "done";
  const capture = ["capturing", "waiting"].includes(s) ? (s === "capturing" ? "running" : "waiting") : s === "unavailable" ? "off" : s === "failed" && !job.captured_at ? "failed" : "done";
  const grade =
    s === "done"
      ? "done"
      : s === "grading"
        ? "running"
        : s === "queued"
          ? "waiting"
          : s === "awaiting_key"
            ? "needs_key"
            : s === "failed" && job.captured_at
              ? "failed"
              : s === "unavailable"
                ? "off"
                : "pending";
  return [
    { key: "checks", label: "Measuring: resume, GitHub, links, domain", state: checks },
    { key: "capture", label: "Opening the page and taking screenshots", state: capture },
    { key: "grade", label: "Gemini looks at design, first impression and writing", state: grade },
  ];
}
