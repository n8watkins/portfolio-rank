// The blog's automation, which the owner controls from /admin/blog
// (docs/CONTENT-ENGINE.md, "Automation"): on or off, the drafting days, how
// many drafts a week, drafts for review or publishing automatically, and a
// queue of topics the next scheduled drafts use. Stored in the database, so
// a change takes effect at the next night's run without a deploy; the
// night's content job (pipeline/content/engine.mjs contentJob) reads it.
//
// The Worker's config stays the ceiling, never the other way round:
//   CONTENT_MODE             "off" turns everything off whatever is saved;
//                            "dry-run" allows drafts for review only;
//                            "publish" also allows publishing automatically
//   CONTENT_DRAFTS_PER_WEEK  the most drafts a week the page may ask for
//                            (default 2, never above MAX_DRAFTS_PER_WEEK)
// and the engine's own caps still hold (1 draft a night, 2 published posts
// in any 7 days, the quality scorecard, the 08:00 Pacific slot, the Gemini
// and Tavily caps). Saved values above the ceiling are refused; values a
// later config lowered are clamped when read.
//
// Fail closed: readAutomation throws when the settings can't be read (or are
// unreadable), and the night then writes nothing.
import { contentMode, contentWeek } from "./store.mjs";
import { pacificParts } from "../../pipeline/quota-day.mjs";

/** Drafting nights by default (Pacific weekday): Monday and Wednesday. */
export const DEFAULT_DAYS = [1, 3];
/** Nights a draft may be scheduled: Monday to Saturday (Sunday night picks the week's ideas). */
export const DRAFT_DAYS = [1, 2, 3, 4, 5, 6];
/** The highest CONTENT_DRAFTS_PER_WEEK honoured: Tavily's 50 a week at 10 a post leaves room for 5. */
export const MAX_DRAFTS_PER_WEEK = 4;
/**
 * "Drafts to keep ready" (owner, 2026-11-12): while fewer drafts than this
 * wait for review, any night from Monday to Saturday writes one more (still
 * one a night, inside the same Gemini, Tavily and image caps), beyond the
 * drafts a week. 0 turns it off; at most MAX_KEEP_READY.
 */
export const MAX_KEEP_READY = 5;
/** A queued topic is at most this long, and the queue at most this many. */
export const TOPIC_MAX = 200;
export const QUEUE_MAX = 20;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const AUTOMATION_TABLES = [
  `CREATE TABLE IF NOT EXISTS content_settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS content_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    added_at TEXT NOT NULL,
    added_by TEXT,
    used_at TEXT,
    night TEXT,
    post_id TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS content_topics_status_idx ON content_topics (status, id)",
];

/** The ceiling from the Worker's config. */
export function automationBounds(env = {}) {
  const maxMode = contentMode(env.CONTENT_MODE);
  const raw = Number.parseInt(String(env.CONTENT_DRAFTS_PER_WEEK ?? ""), 10);
  const maxPerWeek = Math.max(0, Math.min(MAX_DRAFTS_PER_WEEK, Number.isFinite(raw) ? raw : DEFAULT_DAYS.length));
  return { maxMode, maxPerWeek, canPublish: maxMode === "publish", canRun: maxMode !== "off" };
}

/** What applies before the owner saves anything: today's config. */
export function automationDefaults(env = {}) {
  const b = automationBounds(env);
  return { enabled: b.canRun, mode: "review", days: DEFAULT_DAYS.filter((d) => DRAFT_DAYS.includes(d)), perWeek: Math.min(b.maxPerWeek, DEFAULT_DAYS.length), keepReady: 0 };
}

const uniqDays = (days) => [...new Set((Array.isArray(days) ? days : []).map(Number))].filter((d) => DRAFT_DAYS.includes(d)).sort((a, b) => a - b);

/**
 * Checks a change from the page against the ceiling. Returns { settings }
 * or { error } in plain words; never raises a cap.
 */
export function validateAutomation(input, env = {}) {
  const b = automationBounds(env);
  if (!input || typeof input !== "object") return { error: "Nothing to save." };
  const enabled = input.enabled === true;
  const mode = input.mode === "publish" ? "publish" : input.mode === "review" ? "review" : null;
  if (!mode) return { error: "Pick a mode." };
  if (mode === "publish" && !b.canPublish) return { error: 'Publishing automatically is off in the Worker\'s config (CONTENT_MODE is not "publish"), so the page can\'t turn it on.' };
  if (enabled && !b.canRun) return { error: 'The content engine is off in the Worker\'s config (CONTENT_MODE is "off"), so the page can\'t turn it on.' };
  const days = uniqDays(input.days);
  if (enabled && !days.length) return { error: "Pick at least one day, or turn the automation off." };
  const perWeek = Number(input.perWeek);
  if (!Number.isInteger(perWeek) || perWeek < 1) return { error: "Drafts a week must be at least 1." };
  if (perWeek > b.maxPerWeek) return { error: `At most ${b.maxPerWeek} drafts a week (CONTENT_DRAFTS_PER_WEEK in the Worker's config).` };
  if (perWeek > Math.max(1, days.length)) return { error: `${perWeek} drafts need at least ${perWeek} days: one draft a night at most.` };
  const keepReady = input.keepReady == null ? 0 : Number(input.keepReady);
  if (!Number.isInteger(keepReady) || keepReady < 0 || keepReady > MAX_KEEP_READY) return { error: `Drafts to keep ready is 0 to ${MAX_KEEP_READY}.` };
  return { settings: { enabled, mode, days, perWeek, keepReady } };
}

/** Saved settings within today's ceiling (a later config can only lower them). */
function clamp(saved, env) {
  const b = automationBounds(env);
  const days = uniqDays(saved.days);
  return {
    enabled: saved.enabled === true && b.canRun && days.length > 0,
    mode: saved.mode === "publish" && b.canPublish ? "publish" : "review",
    days,
    perWeek: Math.max(0, Math.min(Number(saved.perWeek) || 0, b.maxPerWeek, days.length)),
    keepReady: Math.max(0, Math.min(Number.isInteger(saved.keepReady) ? saved.keepReady : 0, MAX_KEEP_READY)),
  };
}

/**
 * The settings the night uses: { settings, bounds, saved: { at, by } | null }.
 * `settings.engineMode` is the store's mode for a draft ("dry-run" for review,
 * "publish"), or "off". Throws when the table can't be read or a saved row
 * isn't valid JSON: the caller writes nothing (fail closed).
 */
export async function readAutomation(db, env = {}) {
  const bounds = automationBounds(env);
  const row = (await db.execute("SELECT v, updated_at, updated_by FROM content_settings WHERE k = 'automation'")).rows[0];
  const settings = row ? clamp(JSON.parse(String(row.v)), env) : automationDefaults(env);
  const engineMode = !settings.enabled ? "off" : settings.mode === "publish" ? "publish" : "dry-run";
  return { settings: { ...settings, engineMode }, bounds, saved: row ? { at: String(row.updated_at), by: row.updated_by == null ? null : String(row.updated_by) } : null };
}

/**
 * Saves the owner's settings; returns { settings } or { error }.
 * @param {any} db
 * @param {any} input
 * @param {{ env?: Record<string, unknown>, by?: string | null, now?: Date }} [options]
 */
export async function saveAutomation(db, input, { env = {}, by = null, now = new Date() } = {}) {
  const v = validateAutomation(input, env);
  if (v.error) return v;
  await db.execute({
    sql: `INSERT INTO content_settings (k, v, updated_at, updated_by) VALUES ('automation', ?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [JSON.stringify(v.settings), new Date(now).toISOString(), by],
  });
  return v;
}

/**
 * Drafts due this week by tonight: the chosen days up to and including
 * `weekday`, at most perWeek. Sunday night only picks (0 due).
 */
export function draftsDueBy(settings, weekday) {
  if (weekday === 0) return 0;
  return Math.min(settings.perWeek, settings.days.filter((d) => d <= weekday).length);
}

const plain = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Drafts waiting for the owner's review (what "Drafts to keep ready" counts). */
export async function draftsWaiting(db) {
  return Number((await db.execute("SELECT COUNT(*) AS n FROM posts WHERE status = 'draft'")).rows[0]?.n ?? 0);
}

/** The queue, oldest first, with the used ones last (most recent first, at most 10). */
export async function listTopics(db) {
  const rows = (await db.execute("SELECT id, topic, status, added_at, used_at, night, post_id FROM content_topics ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, CASE status WHEN 'queued' THEN id ELSE -id END LIMIT 40")).rows;
  const all = rows.map((r) => ({ id: Number(r.id), topic: String(r.topic), status: String(r.status), addedAt: String(r.added_at), usedAt: r.used_at == null ? null : String(r.used_at), night: r.night == null ? null : String(r.night), postId: r.post_id == null ? null : String(r.post_id) }));
  return { queued: all.filter((t) => t.status === "queued"), used: all.filter((t) => t.status !== "queued").slice(0, 10) };
}

/**
 * Adds a topic to the end of the queue: { topic } or { error }.
 * @param {any} db
 * @param {unknown} raw
 * @param {{ by?: string | null, now?: Date }} [options]
 */
export async function addTopic(db, raw, { by = null, now = new Date() } = {}) {
  const topic = plain(raw);
  if (topic.length < 3) return { error: "Write a topic of at least a few words." };
  if (topic.length > TOPIC_MAX) return { error: `A topic is at most ${TOPIC_MAX} characters.` };
  const r = await db.execute({
    sql: `INSERT INTO content_topics (topic, added_at, added_by) SELECT ?, ?, ?
          WHERE (SELECT COUNT(*) FROM content_topics WHERE status = 'queued') < ? RETURNING id`,
    args: [topic, new Date(now).toISOString(), by, QUEUE_MAX],
  });
  if (!r.rows.length) return { error: `The queue holds at most ${QUEUE_MAX} topics.` };
  return { topic: { id: Number(r.rows[0].id), topic } };
}

/** Removes a topic still waiting in the queue. */
export async function removeTopic(db, id) {
  const r = await db.execute({ sql: "DELETE FROM content_topics WHERE id = ? AND status = 'queued'", args: [Number(id)] });
  return r.rowsAffected > 0;
}

/** The next queued topic, or null. */
export async function nextTopic(db) {
  const r = (await db.execute("SELECT id, topic FROM content_topics WHERE status = 'queued' ORDER BY id LIMIT 1")).rows[0];
  return r ? { id: Number(r.id), topic: String(r.topic) } : null;
}

/** Marks a queued topic as used by a scheduled draft (status: "used" for a stored draft, "dropped" when it failed its checks). */
export async function markTopicUsed(db, id, { night, postId = null, status = "used", now = new Date() }) {
  await db.execute({
    sql: "UPDATE content_topics SET status = ?, used_at = ?, night = ?, post_id = ? WHERE id = ? AND status = 'queued'",
    args: [status, new Date(now).toISOString(), night, postId, Number(id)],
  });
}

/**
 * When the next scheduled draft could run, in words for the page: the next
 * chosen night from today (Pacific) that still has a draft due this week, or
 * the first chosen night of next week. `doneThisWeek` is this week's
 * finished drafts. Returns { date: "YYYY-MM-DD", weekday, label } or null.
 */
export function nextRun(settings, { now = new Date(), doneThisWeek = 0 } = {}) {
  if (!settings.enabled || !settings.days.length || settings.perWeek < 1) return null;
  const p = pacificParts(new Date(now).getTime());
  // Tonight's run starts at 20:30 Pacific; after 23:30 tonight is over.
  const tonightOver = p.hour * 60 + p.minute >= 23 * 60 + 30;
  for (let i = tonightOver ? 1 : 0; i < 14; i++) {
    const at = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
    const weekday = at.getUTCDay();
    if (!settings.days.includes(weekday)) continue;
    const sameWeek = i < 7 && weekday >= p.weekday && p.weekday !== 0;
    const due = draftsDueBy(settings, weekday);
    if (sameWeek && doneThisWeek >= due) continue;
    if (!sameWeek && draftsDueBy(settings, weekday) < 1) continue;
    const date = at.toISOString().slice(0, 10);
    const label = `${i === 0 ? "Tonight" : i === 1 ? "Tomorrow night" : `${DAY_NAMES[weekday]} night`} (${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}), during the night run from 20:30 Pacific`;
    return { date, weekday, label };
  }
  return null;
}

/**
 * Everything the Automation panel shows: { settings, bounds, saved, topics,
 * next, last, doneThisWeek, problem }. When the settings can't be read the
 * panel says so (problem) and the night writes nothing.
 */
export async function automationView(db, env = {}, { now = new Date() } = {}) {
  let auto = null;
  let problem = null;
  try {
    auto = await readAutomation(db, env);
  } catch (e) {
    problem = `The automation settings can't be read, so scheduled drafts are paused: ${String(e?.message ?? e).slice(0, 160)}`;
  }
  const week = contentWeek(new Date(now));
  const runs = (
    await db.execute({ sql: "SELECT night, at, week, step, mode, status, kind, post_id, detail FROM content_runs WHERE step IN ('pick', 'draft') ORDER BY id DESC LIMIT 20", args: [] })
  ).rows;
  const doneThisWeek = runs.filter((r) => String(r.week) === week && String(r.step) === "draft" && String(r.status) === "ok").length;
  const lastRow = runs[0] ?? null;
  let detail = {};
  try {
    detail = lastRow?.detail ? JSON.parse(String(lastRow.detail)) : {};
  } catch {}
  const last = lastRow
    ? {
        night: String(lastRow.night),
        at: String(lastRow.at),
        step: String(lastRow.step),
        status: String(lastRow.status),
        kind: lastRow.kind == null ? null : String(lastRow.kind),
        postId: lastRow.post_id == null ? null : String(lastRow.post_id),
        stored: detail.stored ?? null,
        reason: detail.reason ?? detail.error ?? (Array.isArray(detail.failures) ? detail.failures.slice(0, 2).join("; ") : null) ?? (Array.isArray(detail.held) ? `kept for review: ${detail.held.join("; ")}` : null),
        picks: Array.isArray(detail.picks) ? detail.picks.map((p) => p.kind) : null,
      }
    : null;
  return {
    settings: auto?.settings ?? null,
    bounds: auto?.bounds ?? automationBounds(env),
    saved: auto?.saved ?? null,
    topics: await listTopics(db),
    next: auto ? nextRun(auto.settings, { now, doneThisWeek }) : null,
    last,
    doneThisWeek,
    problem,
  };
}
