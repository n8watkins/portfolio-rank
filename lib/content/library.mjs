// The blog's image library (docs/CONTENT-ENGINE.md, "Images"): house-style
// illustrations made a few an hour from a queue of themes x subjects
// (pipeline/content/house-style.mjs), each checked once by Gemini and kept
// only when the owner approves it on /admin/images. The content engine uses
// approved images only, matched to an image brief's keywords by tags, and
// not used in the last 10 posts.
//
//   image_library             one row per image: the R2 key (private prefix),
//                             the prompt and model, tags, alt text, caption,
//                             source, licence, credit, the Gemini check, the
//                             neurons it reserved, and status: pending
//                             (waiting for the owner), approved, rejected
//                             (dropped by the owner), rejected-auto (failed
//                             the Gemini check; kept for the owner to see),
//                             retired (was approved, no longer used). One row
//                             per queue item at most (a unique index), so a
//                             subject is generated once: no retries. Rows are
//                             never deleted, whatever happens to the posts
//                             that used them.
//   image_library_uses        which post used which image in which slot.
//   image_library_considered  which post looked at which image for a slot
//                             (a close tag match it did not pick).
//   image_library_overrides   the owner's edits to the queue.
//
// Plain JavaScript: the Worker, the app and the tests all import it.
import { LIBRARY_SUBJECTS, THEMES, imagePrompt } from "../../pipeline/content/house-style.mjs";

export const STATUSES = ["pending", "approved", "rejected", "rejected-auto", "retired"];
/** An approved image is not reused within this many of the latest posts. */
export const RECENT_POSTS = 10;
/** Close matches a post records as considered for a slot, besides the one it used. */
export const CONSIDERED_PER_SLOT = 3;

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
  // Close matches a post looked at and did not pick (schema version 11).
  `CREATE TABLE IF NOT EXISTS image_library_considered (
    image_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (image_id, post_id, slot)
  )`,
  "CREATE INDEX IF NOT EXISTS image_library_considered_post_idx ON image_library_considered (post_id)",
  // The owner's edits to the queue: a replacement subject for a queue item, or a skip (schema version 11).
  `CREATE TABLE IF NOT EXISTS image_library_overrides (
    theme TEXT NOT NULL,
    subject_index INTEGER NOT NULL,
    subject TEXT,
    skipped INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (theme, subject_index)
  )`,
];

/** A subject (what the image shows) is this many characters, after cleaning. */
export const SUBJECT_MIN = 8;
export const SUBJECT_MAX = 300;
/** Alt text is this many characters, after cleaning. */
export const ALT_MIN = 8;
export const ALT_MAX = 160;
/** At most this many tags an image, each at most TAG_MAX characters. */
export const TAGS_MAX = 16;
export const TAG_MAX = 30;
/** The style every library image shares, shown and filtered like a tag (never matched against briefs). */
export const HOUSE_STYLE_TAG = "flat vector";

/**
 * Plain one-line text: control, format (zero-width, direction-changing) and
 * line or paragraph separator characters become spaces, spaces collapse.
 */
export function plainText(value) {
  return String(value)
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cleans text the owner typed into a subject: plain one-line text, a
 * trailing full stop dropped. Returns { ok: true, subject } or { ok: false,
 * error } when it is not text, too short or too long. Everything that
 * reaches Workers AI as a prompt goes through here (the house style is
 * appended after it).
 * @param {unknown} value
 * @returns {{ ok: true, subject: string, error?: undefined } | { ok: false, error: string, subject?: undefined }}
 */
export function cleanSubject(value) {
  if (typeof value !== "string") return { ok: false, error: "Write what the image should show." };
  const subject = plainText(value).replace(/[.\s]+$/, "");
  if (subject.length < SUBJECT_MIN || !/\p{L}{3}/u.test(subject)) return { ok: false, error: `Write at least ${SUBJECT_MIN} characters describing the image.` };
  if (subject.length > SUBJECT_MAX) return { ok: false, error: `Keep it to ${SUBJECT_MAX} characters or fewer (it is ${subject.length}).` };
  return { ok: true, subject };
}

/**
 * Cleans alt text the owner typed: { ok: true, alt } or { ok: false, error }.
 * @param {unknown} value
 * @returns {{ ok: true, alt: string, error?: undefined } | { ok: false, error: string, alt?: undefined }}
 */
export function cleanAlt(value) {
  if (typeof value !== "string") return { ok: false, error: "Write the alt text." };
  const alt = plainText(value);
  if (alt.length < ALT_MIN || !/\p{L}{3}/u.test(alt)) return { ok: false, error: `Alt text needs at least ${ALT_MIN} characters.` };
  if (alt.length > ALT_MAX) return { ok: false, error: `Keep alt text to ${ALT_MAX} characters or fewer (it is ${alt.length}).` };
  return { ok: true, alt };
}

/**
 * Cleans a tag list: lower case, letters, digits, spaces and + # / . -, no repeats; { ok, tags } or { ok: false, error }.
 * @param {unknown} value
 * @returns {{ ok: true, tags: string[], error?: undefined } | { ok: false, error: string, tags?: undefined }}
 */
export function cleanTags(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!list) return { ok: false, error: "Tags are a list." };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") return { ok: false, error: "Each tag is text." };
    const tag = plainText(raw).toLowerCase().replace(/[^\p{L}\p{N} +#/.-]/gu, "").replace(/\s+/g, " ").trim();
    if (!tag) continue;
    if (tag.length > TAG_MAX) return { ok: false, error: `A tag is at most ${TAG_MAX} characters ("${tag.slice(0, 20)}...").` };
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > TAGS_MAX) return { ok: false, error: `At most ${TAGS_MAX} tags.` };
  return { ok: true, tags: out };
}

// Words of the house style that every subject repeats; they say nothing about what it shows.
const STYLE_WORDS = new Set(["flat", "amber", "grey", "gray", "simple", "small", "one", "two", "three", "beside", "highlighted", "drawn", "plain", "shape", "shape", "single", "accent", "thin", "soft", "light", "outlined", "raised", "next", "above", "below", "over", "into", "from", "each", "other", "rest", "all", "no", "text", "letter", "number", "label", "side", "row", "half", "like", "showing", "show", "top", "bottom", "faint", "clean", "tidy", "about", "abstract", "slightly", "exactly", "several", "neatly", "calm", "lit", "stay", "fade", "made", "line", "bar", "block", "place", "snapping", "floating", "between", "around", "along", "near", "lifted", "lifting", "tab", "icon", "fold", "paper", "unfolding"]);

/** Up to `max` keywords of a subject, in order: what the image shows, without style filler. */
export function subjectKeywords(subject, max = 5) {
  const out = [];
  for (const w of tokens([subject])) {
    if (STYLE_WORDS.has(w) || w.length < 3) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Short, specific alt text for an image made from `subject`: the subject
 * without its leading "A flat", cut at a clause or word boundary to fit, and
 * "for <theme>" when it has one. Generated at creation, editable later.
 */
export function altFor(subject, themeLabel = null) {
  let s = plainText(subject).replace(/^(an?|the)\s+/i, "").replace(/^flat\s+/i, "").replace(/[.\s]+$/, "");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const suffix = themeLabel ? `, for ${String(themeLabel).replace(/\s*\(.*\)$/, "").toLowerCase()}` : "";
  const room = ALT_MAX - suffix.length;
  if (s.length > room) {
    const cut = s.slice(0, room);
    const comma = cut.lastIndexOf(", ");
    s = comma > 40 ? cut.slice(0, comma) : cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : room);
  }
  return `${s}${suffix}`;
}

/** An image's tags at creation: the theme's tags, then the subject's keywords, no repeats, at most TAGS_MAX. */
export function tagsFor({ themeTags = [], extra = [], subject = "" }) {
  const out = [];
  for (const t of [...themeTags, ...extra, ...subjectKeywords(subject)]) {
    const tag = String(t).toLowerCase().trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, TAGS_MAX);
}

/** The owner's edits keyed "theme#index" -> { subject, skipped }. */
async function overrides(db) {
  const r = await db.execute("SELECT theme, subject_index, subject, skipped FROM image_library_overrides");
  return new Map(r.rows.map((x) => [`${x.theme}#${x.subject_index}`, { subject: x.subject == null ? null : String(x.subject), skipped: Number(x.skipped) === 1 }]));
}

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
  style: String(r.source) === "workers-ai" ? HOUSE_STYLE_TAG : String(r.source),
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

/** Queue items (theme x subject) that have no image yet and are not skipped, in queue order. */
export async function queuedSubjects(db, { limit = Infinity } = {}) {
  return (await queueItems(db)).filter((s) => !s.skipped).slice(0, limit);
}

/**
 * Every queue item that has no image yet, in queue order, with the owner's
 * edits applied: `subject`, `alt`, `tags` and `prompt` are what will be made,
 * `original` the built-in subject, `edited` whether it was changed,
 * `skipped` whether the owner took it out of the queue.
 */
export async function queueItems(db) {
  const done = new Set((await db.execute("SELECT theme, subject_index FROM image_library WHERE subject_index IS NOT NULL")).rows.map((r) => `${r.theme}#${r.subject_index}`));
  const edits = await overrides(db);
  return LIBRARY_SUBJECTS.filter((s) => !done.has(`${s.theme}#${s.index}`)).map((s) => {
    const o = edits.get(`${s.theme}#${s.index}`);
    const subject = o?.subject ?? s.subject;
    const edited = o?.subject != null && o.subject !== s.subject;
    const theme = THEMES.find((t) => t.id === s.theme);
    return {
      ...s,
      subject,
      alt: edited ? altFor(subject, s.themeLabel) : s.alt,
      tags: edited ? tagsFor({ themeTags: theme?.tags ?? [], subject }) : tagsFor({ themeTags: s.tags, subject }),
      original: s.subject,
      edited,
      skipped: o?.skipped ?? false,
      prompt: edited ? imagePrompt(subject) : s.prompt,
    };
  });
}

/**
 * The owner's edit of one queue item: op "edit" (with `subject`), "skip",
 * "unskip" or "reset" (back to the built-in subject, not skipped). Returns
 * { ok: true } or { ok: false, error } ("bad_request" for an unknown item or
 * op, otherwise the cleaning message; "already_made" when it has an image).
 */
export async function editQueueItem(db, { theme, index, op, subject, now = new Date() }) {
  const item = LIBRARY_SUBJECTS.find((s) => s.theme === theme && s.index === index);
  if (!item || !["edit", "skip", "unskip", "reset"].includes(op)) return { ok: false, error: "bad_request" };
  const made = await db.execute({ sql: "SELECT 1 FROM image_library WHERE theme = ? AND subject_index = ?", args: [theme, index] });
  if (made.rows.length) return { ok: false, error: "already_made" };
  const at = new Date(now).toISOString();
  if (op === "reset") {
    await db.execute({ sql: "DELETE FROM image_library_overrides WHERE theme = ? AND subject_index = ?", args: [theme, index] });
    return { ok: true };
  }
  let text = null;
  if (op === "edit") {
    const c = cleanSubject(subject);
    if (!c.ok) return { ok: false, error: c.error };
    text = c.subject;
  }
  // edit keeps a skip; skip and unskip keep an edit.
  await db.execute({
    sql: `INSERT INTO image_library_overrides (theme, subject_index, subject, skipped, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (theme, subject_index) DO UPDATE SET subject = COALESCE(excluded.subject, subject), skipped = CASE ? WHEN 'edit' THEN skipped ELSE excluded.skipped END, updated_at = excluded.updated_at`,
    args: [theme, index, text, op === "skip" ? 1 : 0, at, op],
  });
  return { ok: true };
}

/**
 * A queue item for an image the owner asked for: not tied to a queue slot
 * (no subject index), so it never uses one up. `theme` is one of the themes'
 * ids, else "custom". `subject` must already be cleaned (cleanSubject).
 */
export function customItem({ subject, theme }) {
  const th = THEMES.find((t) => t.id === theme);
  return {
    theme: th ? th.id : "custom",
    themeLabel: th ? th.theme : "Your own",
    index: null,
    subject,
    alt: altFor(subject, th?.theme ?? null),
    tags: tagsFor({ themeTags: th ? th.tags : [], subject }),
    prompt: imagePrompt(subject),
    custom: true,
  };
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

const WITH_USES = `SELECT l.*, (SELECT COUNT(DISTINCT u.post_id) FROM image_library_uses u WHERE u.image_id = l.id) AS uses,
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
 * Images by status (all when none is given), newest first, with the number of posts that used each.
 * @returns {Promise<ReturnType<typeof rowOf>[]>}
 */
export async function listImages(db, { status = null, limit = 500 } = {}) {
  const r = status
    ? await db.execute({ sql: `${WITH_USES} WHERE l.status = ? ORDER BY l.created_at DESC LIMIT ?`, args: [status, limit] })
    : await db.execute({ sql: `${WITH_USES} ORDER BY l.created_at DESC LIMIT ?`, args: [limit] });
  return r.rows.map(rowOf);
}

/**
 * Counts by status, the queue left, images made this month and in all, and
 * the posts that used a library image (all of them, and the published ones).
 */
export async function librarySummary(db, { now = new Date() } = {}) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of (await db.execute("SELECT status, COUNT(*) AS n FROM image_library GROUP BY status")).rows) counts[String(r.status)] = Number(r.n);
  const items = await queueItems(db);
  const month = `${new Date(now).toISOString().slice(0, 7)}-01`;
  const row = (
    await db.execute({
      sql: `SELECT (SELECT COUNT(*) FROM image_library) AS made,
                   (SELECT COUNT(*) FROM image_library WHERE created_at >= ?) AS month,
                   (SELECT COUNT(DISTINCT post_id) FROM image_library_uses) AS posts,
                   (SELECT COUNT(DISTINCT u.post_id) FROM image_library_uses u JOIN posts p ON p.id = u.post_id WHERE p.status = 'published') AS published`,
      args: [month],
    })
  ).rows[0];
  return {
    counts,
    queued: items.filter((s) => !s.skipped).length,
    skipped: items.filter((s) => s.skipped).length,
    subjects: LIBRARY_SUBJECTS.length,
    made: Number(row?.made ?? 0),
    madeThisMonth: Number(row?.month ?? 0),
    usedInPosts: Number(row?.posts ?? 0),
    usedInPublished: Number(row?.published ?? 0),
  };
}

/**
 * Every post each image is tied to, for the cards on /admin/images: Map of
 * image id -> [{ postId, title, status, slot, kind }], where kind is "used"
 * (the post shows it), "considered" (a close match the post did not pick)
 * or "made" (a fresh illustration made for that post). A post that no
 * longer exists keeps its id with a null title.
 */
export async function associations(db) {
  const r = await db.execute(`
    SELECT x.image_id, x.post_id, x.slot, x.kind, p.title, p.status FROM (
      SELECT image_id, post_id, slot, 'used' AS kind, MIN(at) AS at FROM image_library_uses GROUP BY image_id, post_id, slot
      UNION ALL SELECT image_id, post_id, slot, 'considered' AS kind, at FROM image_library_considered
      UNION ALL SELECT id AS image_id, post_id, '' AS slot, 'made' AS kind, created_at AS at FROM image_library WHERE post_id IS NOT NULL
    ) x LEFT JOIN posts p ON p.id = x.post_id ORDER BY x.at DESC`);
  const out = new Map();
  for (const row of r.rows) {
    const id = String(row.image_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ postId: String(row.post_id), title: row.title == null ? null : String(row.title), status: row.status == null ? null : String(row.status), slot: String(row.slot ?? ""), kind: String(row.kind) });
  }
  return out;
}

/** What each owner action does: the statuses it applies to and the status it sets. */
export const ACTIONS = {
  keep: { from: ["pending", "rejected-auto"], to: "approved" },
  drop: { from: ["pending", "rejected-auto"], to: "rejected" },
  retire: { from: ["approved"], to: "retired" },
  // Undo of a drop: back to where it was (`to`: "pending" or "rejected-auto").
  restore: { from: ["rejected"], to: null, back: ["pending", "rejected-auto"] },
};

/**
 * The owner's decision on one image. Returns { image } or { error } with
 * "not_found", "wrong_status" or "bad_request" (a restore to a status it
 * can't go back to). The status check is part of the update, so two clicks
 * at once can't both apply.
 * @param {any} db
 * @param {{ id: string, action: string, actor: string, to?: string | null, now?: Date }} args
 */
export async function decide(db, { id, action, actor, to = null, now = new Date() }) {
  const a = ACTIONS[action];
  if (!a) throw new Error(`unknown action ${action}`);
  const target = a.to ?? to;
  if (a.back && !a.back.includes(target)) return { error: "bad_request" };
  const r = await db.execute({
    sql: `UPDATE image_library SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status IN (${a.from.map(() => "?").join(", ")})`,
    args: [target, new Date(now).toISOString(), actor, id, ...a.from],
  });
  if (r.rowsAffected === 1) return { image: await getImage(db, id) };
  return { error: (await getImage(db, id)) ? "wrong_status" : "not_found" };
}

/**
 * The owner's edit of an image's alt text and tags (either or both).
 * Returns { image } or { error } ("not_found", or the cleaning message).
 */
export async function editImage(db, { id, alt, tags }) {
  const sets = [];
  const args = [];
  if (alt !== undefined) {
    const c = cleanAlt(alt);
    if (!c.ok) return { error: c.error };
    sets.push("alt = ?");
    args.push(c.alt);
  }
  if (tags !== undefined) {
    const c = cleanTags(tags);
    if (!c.ok) return { error: c.error };
    sets.push("tags = ?");
    args.push(JSON.stringify(c.tags));
  }
  if (!sets.length) return { error: "Nothing to change." };
  const r = await db.execute({ sql: `UPDATE image_library SET ${sets.join(", ")} WHERE id = ?`, args: [...args, id] });
  if (r.rowsAffected !== 1) return { error: "not_found" };
  return { image: await getImage(db, id) };
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
 * Approved images that fit a brief, best first: most shared words with
 * their tags (at least one), then the least used, then the longest unused.
 * `exclude` holds ids already in this post. With `allowRecent` false (the
 * default), images used in the last 10 posts are skipped.
 */
export async function rankLibrary(db, { keywords, exclude = new Set(), allowRecent = false, limit = CONSIDERED_PER_SLOT + 1 }) {
  const recent = allowRecent ? new Set() : await recentlyUsed(db);
  const approved = await listImages(db, { status: "approved", limit: 2000 });
  const scored = [];
  for (const img of approved) {
    if (exclude.has(img.id) || recent.has(img.id)) continue;
    const score = matchScore(keywords, [...img.tags, img.theme]);
    if (score >= 1) scored.push({ img, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.img.uses ?? 0) - (b.img.uses ?? 0) || String(a.img.lastUsedAt ?? "").localeCompare(String(b.img.lastUsedAt ?? "")));
  return scored.slice(0, limit);
}

/** The best approved image for a brief (rankLibrary's first), or null. */
export async function matchLibrary(db, opts) {
  return (await rankLibrary(db, { ...opts, limit: 1 }))[0]?.img ?? null;
}

/** Records that a post used an image. */
export async function recordUse(db, { imageId, postId, slot, now = new Date() }) {
  await db.execute({ sql: "INSERT INTO image_library_uses (image_id, post_id, slot, at) VALUES (?, ?, ?, ?)", args: [imageId, postId, slot, new Date(now).toISOString()] });
}

/** Records that a post looked at an image for a slot and did not pick it (once per image, post and slot). */
export async function recordConsidered(db, { imageId, postId, slot, now = new Date() }) {
  await db.execute({ sql: "INSERT INTO image_library_considered (image_id, post_id, slot, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", args: [imageId, postId, slot, new Date(now).toISOString()] });
}
