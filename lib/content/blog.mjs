// The blog's reads and the owner's review (docs/CONTENT-ENGINE.md, "Where
// posts live" and "Review and publish"). The public pages only ever see
// posts that are published and whose publish_at has passed; drafts,
// rejected, dropped and unpublished posts exist only for the admin.
//
// Review (owner, 2026-11-11): the engine writes drafts, the owner publishes
// or rejects each one on /admin/blog. Publishing keeps the weekly cap
// (PUBLISH_CAP in any 7 days) in the same statement that publishes, like the
// engine's own publish (lib/content/store.mjs storePost). Every decision is
// recorded on the post (checks.owner) with who made it and when.
// Plain JavaScript: the pages, the admin API and the tests import it.
import { PUBLISH_CAP, postFromRow } from "./store.mjs";

const WEEK_MS = 7 * 86400000;
const iso = (t) => new Date(t).toISOString();

/** Words a minute for "N min read". */
export const WORDS_PER_MINUTE = 220;

/** A tag as it appears in an address: "Developer Careers" -> "developer-careers". */
export function tagSlug(tag) {
  return String(tag)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The words a reader reads: the body without image markers, Markdown marks and links' addresses. */
export function bodyWords(body) {
  const text = String(body ?? "")
    .replace(/\[\[image:[a-z0-9-]+\]\]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*`_-]+/g, " ");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Whole minutes to read a body, at least 1. */
export function readingMinutes(body) {
  return Math.max(1, Math.round(bodyWords(body) / WORDS_PER_MINUTE));
}

const PUBLIC_WHERE = "status = 'published' AND publish_at IS NOT NULL AND publish_at <= ?";

/**
 * Published posts, newest first, as the list and the feed need them (no
 * fact sheet or checks). `tag` keeps only posts with that tag (by slug).
 * @param {any} db
 * @param {{ now: Date | number | string, limit?: number, tag?: string | null }} opts
 */
export async function listPublished(db, { now, limit = 50, tag = null } = {}) {
  const r = await db.execute({
    sql: `SELECT id, slug, kind, title, subtitle, tags, images, body, data_as_of, publish_at
          FROM posts WHERE ${PUBLIC_WHERE} ORDER BY publish_at DESC, id LIMIT ?`,
    args: [iso(now), tag ? 500 : limit],
  });
  const posts = r.rows.map((row) => {
    const tags = parse(row.tags, []);
    return {
      id: String(row.id),
      slug: String(row.slug),
      kind: String(row.kind),
      title: String(row.title),
      subtitle: row.subtitle == null ? null : String(row.subtitle),
      tags,
      images: parse(row.images, []),
      dataAsOf: String(row.data_as_of),
      publishAt: String(row.publish_at),
      minutes: readingMinutes(row.body),
    };
  });
  return (tag ? posts.filter((p) => p.tags.some((t) => tagSlug(t) === tag)) : posts).slice(0, limit);
}

/** Every tag of the published posts with how many posts carry it, most used first. */
export function tagsOf(posts) {
  const counts = new Map();
  for (const p of posts)
    for (const t of p.tags) {
      const slug = tagSlug(t);
      if (!slug) continue;
      const seen = counts.get(slug);
      counts.set(slug, { slug, name: seen?.name ?? t, count: (seen?.count ?? 0) + 1 });
    }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** One published post by its slug, or null (also null before its publish_at). */
export async function getPublished(db, slug, { now }) {
  const r = await db.execute({ sql: `SELECT * FROM posts WHERE slug = ? AND ${PUBLIC_WHERE}`, args: [String(slug), iso(now)] });
  return r.rows[0] ? withMinutes(postFromRow(r.rows[0])) : null;
}

/** Any post by id, whatever its status (the admin's preview). */
export async function getPost(db, id) {
  const r = await db.execute({ sql: "SELECT * FROM posts WHERE id = ?", args: [String(id)] });
  return r.rows[0] ? withMinutes(postFromRow(r.rows[0])) : null;
}

/** Posts in the review queue and the rest, for /admin/blog, newest first. */
export async function reviewQueue(db, { limit = 50 } = {}) {
  const r = await db.execute({ sql: "SELECT * FROM posts ORDER BY created_at DESC, id LIMIT ?", args: [limit] });
  const all = r.rows.map((row) => withMinutes(postFromRow(row)));
  const by = (s) => all.filter((p) => s.includes(p.status));
  return { drafts: by(["draft"]), published: by(["published"]), closed: by(["rejected", "dropped", "unpublished"]) };
}

/** Posts published (or scheduled) within 7 days either side of `at`: what the cap counts. */
export async function publishedAround(db, at) {
  const t = new Date(at).getTime();
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND publish_at > ? AND publish_at < ?",
    args: [iso(t - WEEK_MS), iso(t + WEEK_MS)],
  });
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * When a draft goes live if the owner publishes it now: its scheduled
 * publish_at (the engine's next 08:00 Pacific) while that is still ahead,
 * else at once.
 */
export function publishTime(post, now) {
  const scheduled = post.publishAt ? new Date(post.publishAt).getTime() : NaN;
  const t = new Date(now).getTime();
  return new Date(Number.isFinite(scheduled) && scheduled > t ? scheduled : t);
}

/** The review decisions and the status each one starts from. */
export const REVIEW_ACTIONS = {
  publish: { from: "draft", to: "published" },
  reject: { from: "draft", to: "rejected" },
  unpublish: { from: "published", to: "unpublished" },
};

/**
 * Applies one owner decision. Returns { ok: true, status, publishAt? } or
 * { ok: false, error } with error one of "not_found", "wrong_status" and
 * "weekly_cap". Publishing counts the cap in the same statement, so two
 * clicks can't both slip under it.
 * @param {any} db
 * @param {string} id
 * @param {{ action: string, by: string, note?: string | null, now: Date | number }} opts
 * @returns {Promise<{ ok: true, status: string, publishAt?: string } | { ok: false, error: string, status?: string }>}
 */
export async function review(db, id, { action, by, note = null, now }) {
  const rule = REVIEW_ACTIONS[action];
  if (!rule) return { ok: false, error: "bad_action" };
  const post = await getPost(db, id);
  if (!post) return { ok: false, error: "not_found" };
  if (post.status !== rule.from) return { ok: false, error: "wrong_status", status: post.status };
  const at = iso(now);
  const owner = JSON.stringify({ action, by: String(by), at, ...(note ? { note: String(note).slice(0, 500) } : {}) });
  if (action === "publish") {
    const when = publishTime(post, now);
    const t = when.getTime();
    const res = await db.execute({
      sql: `UPDATE posts SET status = 'published', publish_at = ?, published_at = ?, newsletter_pending = 1, updated_at = ?,
              checks = json_set(checks, '$.owner', json(?))
            WHERE id = ? AND status = 'draft'
              AND (SELECT COUNT(*) FROM posts WHERE status = 'published' AND publish_at > ? AND publish_at < ?) < ?`,
      args: [iso(when), at, at, owner, post.id, iso(t - WEEK_MS), iso(t + WEEK_MS), PUBLISH_CAP],
    });
    if (res.rowsAffected > 0) return { ok: true, status: "published", publishAt: iso(when) };
    const again = await getPost(db, id);
    if (again?.status !== "draft") return { ok: false, error: "wrong_status", status: again?.status };
    return { ok: false, error: "weekly_cap" };
  }
  const res = await db.execute({
    sql: `UPDATE posts SET status = ?, updated_at = ?, checks = json_set(checks, '$.owner', json(?))${action === "unpublish" ? ", newsletter_pending = 0" : ""}
          WHERE id = ? AND status = ?`,
    args: [rule.to, at, owner, post.id, rule.from],
  });
  if (res.rowsAffected === 0) return { ok: false, error: "wrong_status" };
  return { ok: true, status: rule.to };
}

function withMinutes(post) {
  return { ...post, minutes: readingMinutes(post.body) };
}

function parse(v, fallback) {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}
