// The editor's guidelines (docs/CONTENT-ENGINE.md, "Quality tools"): a short,
// owner-edited list of rules, built from the owner's notes on drafts, that
// goes into every writer request as `editor_guidelines`
// (pipeline/content/writer.mjs sheetForWriter). Edited on
// /admin/blog/guidelines. Length-capped so it can't crowd out the facts.
//
//   content_guidelines  id, the rule, the post whose note it came from (or
//                       null), when it was added and last changed.
//
// Plain JavaScript: the app, the engine and the tests share it.

/** At most this many guidelines, each at most GUIDELINE_MAX characters, GUIDELINES_TOTAL in all. */
export const GUIDELINES_MAX = 20;
export const GUIDELINE_MIN = 8;
export const GUIDELINE_MAX = 200;
export const GUIDELINES_TOTAL = 2000;

export const GUIDELINE_TABLES = [
  `CREATE TABLE IF NOT EXISTS content_guidelines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    from_post TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

/**
 * A guideline the owner typed: plain one-line text, GUIDELINE_MIN to GUIDELINE_MAX characters.
 * @param {unknown} value
 * @returns {{ ok: true, text: string, error?: undefined } | { ok: false, error: string, text?: undefined }}
 */
export function cleanGuideline(value) {
  if (typeof value !== "string") return { ok: false, error: "Write the guideline." };
  const text = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < GUIDELINE_MIN || !/\p{L}{3}/u.test(text)) return { ok: false, error: `A guideline needs at least ${GUIDELINE_MIN} characters.` };
  if (text.length > GUIDELINE_MAX) return { ok: false, error: `Keep a guideline to ${GUIDELINE_MAX} characters or fewer (it is ${text.length}).` };
  return { ok: true, text };
}

/** Every guideline, oldest first: [{ id, text, fromPost, createdAt, updatedAt }]. */
export async function listGuidelines(db) {
  return (await db.execute("SELECT * FROM content_guidelines ORDER BY id")).rows.map((r) => ({
    id: Number(r.id),
    text: String(r.text),
    fromPost: r.from_post == null ? null : String(r.from_post),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

/** The guideline texts for the writer: [string], within the caps. */
export async function writerGuidelines(db) {
  try {
    const out = [];
    let total = 0;
    for (const g of await listGuidelines(db)) {
      if (out.length >= GUIDELINES_MAX || total + g.text.length > GUIDELINES_TOTAL) break;
      out.push(g.text);
      total += g.text.length;
    }
    return out;
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return [];
    throw e;
  }
}

/**
 * One owner edit: op "add" (text, fromPost?), "edit" (id, text) or
 * "remove" (id). Returns { ok: true } or { ok: false, error } (the cleaning
 * message, "full" when the list is at its caps, "not_found").
 * @param {any} db
 * @param {{ op: string, id?: number, text?: unknown, fromPost?: string | null, now?: Date }} args
 */
export async function editGuidelines(db, { op, id, text, fromPost = null, now = new Date() }) {
  const at = new Date(now).toISOString();
  if (op === "remove") {
    const r = await db.execute({ sql: "DELETE FROM content_guidelines WHERE id = ?", args: [Number(id)] });
    return r.rowsAffected === 1 ? { ok: true } : { ok: false, error: "not_found" };
  }
  const c = cleanGuideline(text);
  if (!c.ok) return { ok: false, error: c.error };
  const all = await listGuidelines(db);
  if (op === "add") {
    if (all.length >= GUIDELINES_MAX) return { ok: false, error: `The list is full (${GUIDELINES_MAX}); edit or remove one first.` };
    if (all.reduce((a, g) => a + g.text.length, 0) + c.text.length > GUIDELINES_TOTAL) return { ok: false, error: `The list is full (${GUIDELINES_TOTAL} characters in all); shorten or remove one first.` };
    await db.execute({ sql: "INSERT INTO content_guidelines (text, from_post, created_at, updated_at) VALUES (?, ?, ?, ?)", args: [c.text, fromPost, at, at] });
    return { ok: true };
  }
  if (op === "edit") {
    const old = all.find((g) => g.id === Number(id));
    if (!old) return { ok: false, error: "not_found" };
    if (all.reduce((a, g) => a + (g.id === old.id ? c.text.length : g.text.length), 0) > GUIDELINES_TOTAL) return { ok: false, error: `That makes the list longer than ${GUIDELINES_TOTAL} characters; shorten it.` };
    await db.execute({ sql: "UPDATE content_guidelines SET text = ?, updated_at = ? WHERE id = ?", args: [c.text, at, old.id] });
    return { ok: true };
  }
  return { ok: false, error: "bad_request" };
}

/**
 * The owner's notes on drafts that aren't guidelines yet, newest first, to
 * offer on /admin/blog/guidelines: [{ postId, title, note, at }]. Notes come
 * from Reject (checks.owner.note) and from rewrites (content_jobs.notes).
 */
export async function noteSuggestions(db, { limit = 20 } = {}) {
  const used = new Set((await listGuidelines(db)).map((g) => g.fromPost).filter(Boolean));
  const out = [];
  const rejected = await db.execute({
    sql: `SELECT id, title, json_extract(checks, '$.owner.note') AS note, json_extract(checks, '$.owner.at') AS at FROM posts
          WHERE json_extract(checks, '$.owner.note') IS NOT NULL ORDER BY updated_at DESC LIMIT ?`,
    args: [limit],
  });
  for (const r of rejected.rows) if (!used.has(String(r.id))) out.push({ postId: String(r.id), title: String(r.title), note: String(r.note), at: String(r.at ?? "") });
  try {
    const rewrites = await db.execute({ sql: "SELECT j.rewrite_of, j.notes, j.created_at, p.title FROM content_jobs j LEFT JOIN posts p ON p.id = j.rewrite_of WHERE j.notes IS NOT NULL ORDER BY j.created_at DESC LIMIT ?", args: [limit] });
    for (const r of rewrites.rows) if (!used.has(String(r.rewrite_of)) && !out.some((x) => x.postId === String(r.rewrite_of) && x.note === String(r.notes))) out.push({ postId: String(r.rewrite_of), title: r.title == null ? "a draft" : String(r.title), note: String(r.notes), at: String(r.created_at) });
  } catch (e) {
    if (!/no such table/i.test(String(e?.message))) throw e;
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
