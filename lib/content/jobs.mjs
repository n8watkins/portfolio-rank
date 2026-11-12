// "Write a draft now" jobs (docs/CONTENT-ENGINE.md, "Write a draft now"):
// one row per draft the owner asked for, with its live status, so the
// /admin/blog page can show "Researching... Writing... Checking... Done"
// while the Workflow (worker/draft.ts) runs it.
//
//   content_jobs  id, the story kind (null: chosen when it runs), the
//                 owner's topic or angle, rewrite_of and notes for "Rewrite
//                 with these notes", status (queued, running, done,
//                 dropped, skipped, failed), the current phase, a plain
//                 message, the post it made, the Pacific day it counts
//                 against, who asked, and the Gemini, Tavily and Workers AI
//                 calls it spent. While Google's AI is busy a job stays
//                 "running" in phase "busy", with the time of its next try
//                 in the message (pipeline/content/busy.mjs).
//
// At most MANUAL_PER_DAY jobs a Pacific day, counted in the same statement
// that inserts one, so two clicks can't both slip under the cap.
// Plain JavaScript: the app, the Worker and the tests share it.
import { pacificParts } from "../../pipeline/quota-day.mjs";

/** Manual drafts (new and rewrites) the owner may start a Pacific day. */
export const MANUAL_PER_DAY = 5;
/** A topic or angle is at most this many characters; rewrite notes at most NOTES_MAX. */
export const TOPIC_MAX = 200;
export const NOTES_MIN = 10;
export const NOTES_MAX = 1000;
/** What a draft usually takes, for the page ("usually 1 to 3 minutes"). */
export const EXPECTED_SECONDS = { min: 60, max: 180 };

export const JOB_TABLES = [
  `CREATE TABLE IF NOT EXISTS content_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT,
    topic TEXT,
    rewrite_of TEXT,
    notes TEXT,
    status TEXT NOT NULL,
    phase TEXT,
    message TEXT,
    post_id TEXT,
    day TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    gemini INTEGER NOT NULL DEFAULT 0,
    tavily INTEGER NOT NULL DEFAULT 0,
    images_ai INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS content_jobs_day_idx ON content_jobs (day)",
];

/** The Pacific date of a moment, YYYY-MM-DD (the day the cap counts against). */
export function pacificDay(now = new Date()) {
  const p = pacificParts(new Date(now).getTime());
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const plain = (s) =>
  String(s)
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The owner's optional topic or angle: plain one-line text of at most
 * TOPIC_MAX characters. { ok: true, topic } (null when empty) or { ok: false, error }.
 * @param {unknown} value
 * @returns {{ ok: true, topic: string | null, error?: undefined } | { ok: false, error: string, topic?: undefined }}
 */
export function cleanTopic(value) {
  if (value == null || value === "") return { ok: true, topic: null };
  if (typeof value !== "string") return { ok: false, error: "The topic is text." };
  const topic = plain(value);
  if (!topic) return { ok: true, topic: null };
  if (topic.length > TOPIC_MAX) return { ok: false, error: `Keep the topic to ${TOPIC_MAX} characters or fewer (it is ${topic.length}).` };
  return { ok: true, topic };
}

/**
 * The owner's notes for a rewrite: plain text (line breaks kept as " / "),
 * NOTES_MIN to NOTES_MAX characters.
 * @param {unknown} value
 * @returns {{ ok: true, notes: string, error?: undefined } | { ok: false, error: string, notes?: undefined }}
 */
export function cleanNotes(value) {
  if (typeof value !== "string") return { ok: false, error: "Write what to change." };
  const notes = value
    .split(/\r?\n/)
    .map(plain)
    .filter(Boolean)
    .join(" / ");
  if (notes.length < NOTES_MIN) return { ok: false, error: `Write at least ${NOTES_MIN} characters on what to change.` };
  if (notes.length > NOTES_MAX) return { ok: false, error: `Keep the notes to ${NOTES_MAX} characters or fewer (it is ${notes.length}).` };
  return { ok: true, notes };
}

const rowOf = (r) => ({
  id: String(r.id),
  kind: r.kind == null ? null : String(r.kind),
  topic: r.topic == null ? null : String(r.topic),
  rewriteOf: r.rewrite_of == null ? null : String(r.rewrite_of),
  notes: r.notes == null ? null : String(r.notes),
  status: String(r.status),
  phase: r.phase == null ? null : String(r.phase),
  message: r.message == null ? null : String(r.message),
  postId: r.post_id == null ? null : String(r.post_id),
  day: String(r.day),
  requestedBy: String(r.requested_by),
  gemini: Number(r.gemini ?? 0),
  tavily: Number(r.tavily ?? 0),
  imagesAi: Number(r.images_ai ?? 0),
  createdAt: String(r.created_at),
  startedAt: r.started_at == null ? null : String(r.started_at),
  finishedAt: r.finished_at == null ? null : String(r.finished_at),
});

/**
 * Queues one manual draft if the Pacific day has room. Returns { job } or
 * { error: "daily_cap", used }.
 * @param {any} db
 * @param {{ id: string, kind?: string | null, topic?: string | null, rewriteOf?: string | null, notes?: string | null, by: string, now?: Date | number, cap?: number }} args
 */
export async function createJob(db, { id, kind = null, topic = null, rewriteOf = null, notes = null, by, now = new Date(), cap = MANUAL_PER_DAY }) {
  const day = pacificDay(now);
  const at = new Date(now).toISOString();
  const r = await db.execute({
    sql: `INSERT INTO content_jobs (id, kind, topic, rewrite_of, notes, status, phase, day, requested_by, created_at)
          SELECT ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?
          WHERE (SELECT COUNT(*) FROM content_jobs WHERE day = ?) < ?`,
    args: [id, kind, topic, rewriteOf, notes, day, by, at, day, cap],
  });
  if (r.rowsAffected !== 1) return { error: "daily_cap", used: await jobsToday(db, { now }) };
  return { job: await getJob(db, id) };
}

/** One job, or null. */
export async function getJob(db, id) {
  const r = await db.execute({ sql: "SELECT * FROM content_jobs WHERE id = ?", args: [id] });
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** Jobs counted against today's cap. */
export async function jobsToday(db, { now = new Date() } = {}) {
  const r = await db.execute({ sql: "SELECT COUNT(*) AS n FROM content_jobs WHERE day = ?", args: [pacificDay(now)] });
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * The latest jobs, newest first.
 * @returns {Promise<ReturnType<typeof rowOf>[]>}
 */
export async function recentJobs(db, { limit = 10 } = {}) {
  return (await db.execute({ sql: "SELECT * FROM content_jobs ORDER BY created_at DESC LIMIT ?", args: [limit] })).rows.map(rowOf);
}

/** Marks a queued job running (once). Returns true when this call started it. */
export async function startJob(db, id, { now = new Date() } = {}) {
  const r = await db.execute({ sql: "UPDATE content_jobs SET status = 'running', phase = 'starting', started_at = ? WHERE id = ? AND status = 'queued'", args: [new Date(now).toISOString(), id] });
  return r.rowsAffected === 1;
}

/**
 * Takes up a job again after Google's AI was busy (worker/draft.ts sleeps,
 * then tries the draft again): only a running job waiting in phase "busy".
 * Returns true when this call took it.
 */
export async function resumeJob(db, id) {
  const r = await db.execute({ sql: "UPDATE content_jobs SET phase = 'starting' WHERE id = ? AND status = 'running' AND phase = 'busy'", args: [id] });
  return r.rowsAffected === 1;
}

/** Adds what one try of a draft spent to the job's totals (a busy try spends too). */
export async function addSpent(db, id, { gemini = 0, tavily = 0, imagesAi = 0 } = {}) {
  await db.execute({ sql: "UPDATE content_jobs SET gemini = gemini + ?, tavily = tavily + ?, images_ai = images_ai + ? WHERE id = ?", args: [gemini, tavily, imagesAi, id] });
}

/**
 * Gemini as the job saw it, from the request log (pipeline/gemini-log.mjs,
 * run id "manual:<job id>"): every HTTP attempt, the ones answered, the ones
 * turned away because Google was busy (5xx, timeouts), and the answers that
 * came from the backup model. Our daily budget counts every attempt; only
 * answered requests did work. { [jobId]: { attempts, answered, busy, backup } }.
 * @param {any} db
 * @param {string[]} ids
 */
export async function jobCalls(db, ids, { backupModel = "gemini-3.1-flash-lite" } = {}) {
  const out = Object.fromEntries(ids.map((id) => [id, { attempts: 0, answered: 0, busy: 0, backup: 0 }]));
  if (!ids.length) return out;
  let rows;
  try {
    rows = (
      await db.execute({
        sql: `SELECT run_id, COUNT(*) AS attempts,
                     SUM(CASE WHEN status = 200 AND COALESCE(finish_reason, 'STOP') = 'STOP' THEN 1 ELSE 0 END) AS answered,
                     SUM(CASE WHEN status >= 500 OR status = 0 THEN 1 ELSE 0 END) AS busy,
                     SUM(CASE WHEN status = 200 AND model = ? THEN 1 ELSE 0 END) AS backup
              FROM gemini_requests WHERE run_id IN (${ids.map(() => "?").join(", ")}) GROUP BY run_id`,
        args: [backupModel, ...ids.map((id) => `manual:${id}`)],
      })
    ).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return out;
    throw e;
  }
  for (const r of rows) {
    const id = String(r.run_id).slice("manual:".length);
    if (out[id]) out[id] = { attempts: Number(r.attempts ?? 0), answered: Number(r.answered ?? 0), busy: Number(r.busy ?? 0), backup: Number(r.backup ?? 0) };
  }
  return out;
}

/** The live status while it runs. */
export async function setPhase(db, id, { phase, kind, message = null }) {
  await db.execute({ sql: "UPDATE content_jobs SET phase = ?, kind = COALESCE(?, kind), message = COALESCE(?, message) WHERE id = ? AND status = 'running'", args: [phase, kind ?? null, message, id] });
}

/**
 * The end: status done, dropped, skipped or failed, with a plain message, the post and the calls it spent.
 * @param {any} db
 * @param {string} id
 * @param {{ status: string, message?: string | null, postId?: string | null, kind?: string | null, gemini?: number, tavily?: number, imagesAi?: number, now?: Date }} args
 */
export async function finishJob(db, id, { status, message = null, postId = null, kind = null, gemini = 0, tavily = 0, imagesAi = 0, now = new Date() }) {
  await db.execute({
    sql: `UPDATE content_jobs SET status = ?, phase = 'done', message = ?, post_id = ?, kind = COALESCE(?, kind), gemini = gemini + ?, tavily = tavily + ?, images_ai = images_ai + ?, finished_at = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
    args: [status, message, postId, kind, gemini, tavily, imagesAi, new Date(now).toISOString(), id],
  });
}
