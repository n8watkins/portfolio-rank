// The blog's image library (docs/CONTENT-ENGINE.md, "Images"): house-style
// illustrations made a few a night from a queue of themes x subjects
// (pipeline/content/house-style.mjs), each checked once by Gemini and kept
// only when the owner approves it on /admin/images. The content engine uses
// approved images only, matched to an image brief's keywords by tags, and
// not used in the last 10 posts.
//
//   image_library       one row per image: the R2 key (private prefix), the
//                       prompt and model, tags, alt text, caption, source,
//                       licence, credit, the Gemini check, the neurons it
//                       reserved, and status: pending (waiting for the
//                       owner), approved, rejected (dropped by the owner),
//                       rejected-auto (failed the Gemini check; kept for the
//                       owner to see), retired (was approved, no longer used).
//                       One row per queue item at most (a unique index), so a
//                       subject is generated once: no retries.
//   image_library_uses  which post used which image in which slot.
//
// Plain JavaScript: the Worker, the app and the tests all import it.
import { LIBRARY_SUBJECTS } from "../../pipeline/content/house-style.mjs";

export const STATUSES = ["pending", "approved", "rejected", "rejected-auto", "retired"];
/** An approved image is not reused within this many of the latest posts. */
export const RECENT_POSTS = 10;

export const LIBRARY_TABLES = [
  `CREATE TABLE IF NOT EXISTS image_library (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    subject_index INTEGER,
    subject TEXT,
    prompt TEXT,
    model TEXT,
    r2_key TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    tags TEXT NOT NULL,
    alt TEXT NOT NULL,
    caption TEXT NOT NULL,
    source TEXT NOT NULL,
    licence TEXT NOT NULL,
    credit TEXT NOT NULL,
    status TEXT NOT NULL,
    check_result TEXT,
    neurons INTEGER NOT NULL DEFAULT 0,
    post_id TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS image_library_subject_idx ON image_library (theme, subject_index) WHERE subject_index IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS image_library_status_idx ON image_library (status, created_at)",
  `CREATE TABLE IF NOT EXISTS image_library_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS image_library_uses_image_idx ON image_library_uses (image_id)",
  "CREATE INDEX IF NOT EXISTS image_library_uses_at_idx ON image_library_uses (at)",
];

/** The private R2 key of a library image (the public /shots route never serves it). */
export const libraryKey = (env, id) => `private/library/${env}/${id}.jpg`;

const parse = (v, fallback) => {
  try {
    return v == null ? fallback : JSON.parse(String(v));
  } catch {
    return fallback;
  }
};

const rowOf = (r) => ({
  id: String(r.id),
  theme: String(r.theme),
  subjectIndex: r.subject_index == null ? null : Number(r.subject_index),
  subject: r.subject == null ? null : String(r.subject),
  prompt: r.prompt == null ? null : String(r.prompt),
  model: r.model == null ? null : String(r.model),
  key: String(r.r2_key),
  width: r.width == null ? null : Number(r.width),
  height: r.height == null ? null : Number(r.height),
  tags: parse(r.tags, []),
  alt: String(r.alt),
  caption: String(r.caption),
  source: String(r.source),
  licence: String(r.licence),
  credit: String(r.credit),
  status: String(r.status),
  check: parse(r.check_result, null),
  neurons: Number(r.neurons ?? 0),
  postId: r.post_id == null ? null : String(r.post_id),
  createdAt: String(r.created_at),
  decidedAt: r.decided_at == null ? null : String(r.decided_at),
  decidedBy: r.decided_by == null ? null : String(r.decided_by),
  uses: r.uses == null ? undefined : Number(r.uses),
  lastUsedAt: r.last_used_at == null ? null : String(r.last_used_at),
});

/** Queue items (theme x subject) that have no image yet, in queue order. */
export async function queuedSubjects(db, { limit = Infinity } = {}) {
  const done = new Set((await db.execute("SELECT theme, subject_index FROM image_library WHERE subject_index IS NOT NULL")).rows.map((r) => `${r.theme}#${r.subject_index}`));
  return LIBRARY_SUBJECTS.filter((s) => !done.has(`${s.theme}#${s.index}`)).slice(0, limit);
}

/**
 * Stores one image row. Returns false when the queue item already has one
 * (another run made it first), true otherwise.
 */
export async function insertImage(db, img) {
  const r = await db.execute({
    sql: `INSERT INTO image_library (id, theme, subject_index, subject, prompt, model, r2_key, width, height, tags, alt, caption, source, licence, credit, status, check_result, neurons, post_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      img.id,
      img.theme,
      img.subjectIndex ?? null,
      img.subject ?? null,
      img.prompt ?? null,
      img.model ?? null,
      img.key,
      img.width ?? null,
      img.height ?? null,
      JSON.stringify(img.tags ?? []),
      img.alt,
      img.caption,
      img.source,
      img.licence,
      img.credit,
      img.status,
      img.check == null ? null : JSON.stringify(img.check),
      img.neurons ?? 0,
      img.postId ?? null,
      new Date(img.now ?? Date.now()).toISOString(),
    ],
  });
  return r.rowsAffected === 1;
}

const WITH_USES = `SELECT l.*, (SELECT COUNT(*) FROM image_library_uses u WHERE u.image_id = l.id) AS uses,
  (SELECT MAX(at) FROM image_library_uses u WHERE u.image_id = l.id) AS last_used_at FROM image_library l`;

/**
 * One image, or null.
 * @returns {Promise<ReturnType<typeof rowOf> | null>}
 */
export async function getImage(db, id) {
  const r = await db.execute({ sql: `${WITH_USES} WHERE l.id = ?`, args: [id] });
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/**
 * Images by status (all when none is given), newest first, with their use counts.
 * @returns {Promise<ReturnType<typeof rowOf>[]>}
 */
export async function listImages(db, { status = null, limit = 500 } = {}) {
  const r = status
    ? await db.execute({ sql: `${WITH_USES} WHERE l.status = ? ORDER BY l.created_at DESC LIMIT ?`, args: [status, limit] })
    : await db.execute({ sql: `${WITH_USES} ORDER BY l.created_at DESC LIMIT ?`, args: [limit] });
  return r.rows.map(rowOf);
}

/** Counts by status, plus how many queue items are left. */
export async function librarySummary(db) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of (await db.execute("SELECT status, COUNT(*) AS n FROM image_library GROUP BY status")).rows) counts[String(r.status)] = Number(r.n);
  return { counts, queued: (await queuedSubjects(db)).length, subjects: LIBRARY_SUBJECTS.length };
}

/** What each owner action does: the statuses it applies to and the status it sets. */
export const ACTIONS = {
  keep: { from: ["pending", "rejected-auto"], to: "approved" },
  drop: { from: ["pending", "rejected-auto"], to: "rejected" },
  retire: { from: ["approved"], to: "retired" },
};

/**
 * The owner's decision on one image. Returns { image } or { error } with
 * "not_found" or "wrong_status". The status check is part of the update, so
 * two clicks at once can't both apply.
 */
export async function decide(db, { id, action, actor, now = new Date() }) {
  const a = ACTIONS[action];
  if (!a) throw new Error(`unknown action ${action}`);
  const r = await db.execute({
    sql: `UPDATE image_library SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status IN (${a.from.map(() => "?").join(", ")})`,
    args: [a.to, new Date(now).toISOString(), actor, id, ...a.from],
  });
  if (r.rowsAffected === 1) return { image: await getImage(db, id) };
  return { error: (await getImage(db, id)) ? "wrong_status" : "not_found" };
}

const STOP = new Set(["and", "the", "for", "with", "your", "you", "our", "how", "what", "why", "of", "to", "in", "on", "a", "an", "is", "are", "it", "its"]);
/** Lower-case words of 2 or more characters ("ai", "ui"), singular, without common filler words. */
export function tokens(list) {
  const out = new Set();
  for (const item of list ?? []) for (const w of String(item).toLowerCase().split(/[^a-z0-9+#]+/)) if (w.length >= 2 && !STOP.has(w)) out.add(w.replace(/s$/, ""));
  return out;
}

/** How well an image's tags fit a brief's keywords: the number of shared words. */
export function matchScore(keywords, tags) {
  const k = tokens(keywords);
  let n = 0;
  for (const w of tokens(tags)) if (k.has(w)) n++;
  return n;
}

/** Image ids used by the latest `posts` posts. */
export async function recentlyUsed(db, { posts = RECENT_POSTS } = {}) {
  const r = await db.execute({
    sql: `SELECT DISTINCT image_id FROM image_library_uses WHERE post_id IN (
            SELECT post_id FROM image_library_uses GROUP BY post_id ORDER BY MAX(at) DESC LIMIT ?)`,
    args: [posts],
  });
  return new Set(r.rows.map((x) => String(x.image_id)));
}

/**
 * The best approved image for a brief: most shared words with its tags (at
 * least one), then the least used, then the longest unused. `exclude` holds
 * ids already in this post. With `allowRecent` false (the default), images
 * used in the last 10 posts are skipped. Returns the image or null.
 */
export async function matchLibrary(db, { keywords, exclude = new Set(), allowRecent = false }) {
  const recent = allowRecent ? new Set() : await recentlyUsed(db);
  const approved = await listImages(db, { status: "approved", limit: 2000 });
  let best = null;
  for (const img of approved) {
    if (exclude.has(img.id) || recent.has(img.id)) continue;
    const score = matchScore(keywords, [...img.tags, img.theme]);
    if (score < 1) continue;
    const better =
      !best ||
      score > best.score ||
      (score === best.score && (img.uses < best.img.uses || (img.uses === best.img.uses && String(img.lastUsedAt ?? "") < String(best.img.lastUsedAt ?? ""))));
    if (better) best = { img, score };
  }
  return best?.img ?? null;
}

/** Records that a post used an image. */
export async function recordUse(db, { imageId, postId, slot, now = new Date() }) {
  await db.execute({ sql: "INSERT INTO image_library_uses (image_id, post_id, slot, at) VALUES (?, ?, ?, ?)", args: [imageId, postId, slot, new Date(now).toISOString()] });
}
