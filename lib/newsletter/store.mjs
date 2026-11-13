// The blog newsletter's issues: one Kit broadcast per published post
// (lib/newsletter/schema.mjs, AUTOMATION.md "Newsletter"). Kit keeps the
// subscribers, so nothing here holds an address.
import { randomBytes } from "node:crypto";
import { postFromRow } from "../content/store.mjs";

/** A post published longer ago than this when the newsletter first sees it is not emailed (a backlog never goes out at once). */
export const ISSUE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** An issue whose Kit call never reported back within this long is stopped, never retried (Kit may have it; a retry could send twice). */
export const CREATING_STUCK_MS = 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/** Where someone signed up, for Kit's referrer: a same-site path (no query) and the form, e.g. "/blog/x (sidebar)". */
export function cleanSource(path, form) {
  const p = String(path ?? "").split(/[?#]/)[0];
  const safe = p.startsWith("/") && !p.startsWith("//") && p.length <= 160 && /^[\x21-\x7e]+$/.test(p) ? p : null;
  const f = ["sidebar", "after-post", "blog", "footer"].includes(String(form)) ? String(form) : null;
  if (!safe && !f) return null;
  return [safe ?? "?", f ? `(${f})` : null].filter(Boolean).join(" ");
}

/**
 * Turns posts that were published and marked for the newsletter
 * (posts.newsletter_pending) into issues, once each. A post that went live
 * more than ISSUE_MAX_AGE_MS ago is recorded as "skipped" instead, so
 * switching the newsletter on never mails a backlog. Returns the new issues.
 */
export async function queueIssues(db, { now = Date.now() } = {}) {
  const due = (
    await db.execute({
      sql: "SELECT id, publish_at FROM posts WHERE status = 'published' AND newsletter_pending = 1 AND publish_at <= ? ORDER BY publish_at",
      args: [iso(now)],
    })
  ).rows;
  const out = [];
  for (const p of due) {
    const old = Date.parse(String(p.publish_at)) < now - ISSUE_MAX_AGE_MS;
    const id = randomBytes(8).toString("hex");
    const res = await db.batch(
      [
        {
          sql: "INSERT INTO newsletter_issues (id, post_id, status, reason, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(post_id) DO NOTHING",
          args: [id, String(p.id), old ? "skipped" : "queued", old ? "published too long ago" : null, iso(now), old ? iso(now) : null],
        },
        { sql: "UPDATE posts SET newsletter_pending = 0 WHERE id = ?", args: [String(p.id)] },
      ],
      "write"
    );
    if (res[0].rowsAffected > 0) out.push({ id, postId: String(p.id), status: old ? "skipped" : "queued" });
  }
  return out;
}

/** Issues waiting for their Kit broadcast, oldest first, with their post. */
export async function queuedIssues(db) {
  const rows = (
    await db.execute(
      "SELECT i.id AS issue_id, i.created_at AS issue_created_at, p.* FROM newsletter_issues i JOIN posts p ON p.id = i.post_id WHERE i.status = 'queued' ORDER BY i.created_at"
    )
  ).rows;
  return rows.map((r) => ({ id: String(r.issue_id), createdAt: String(r.issue_created_at), post: postFromRow(r) }));
}

/**
 * Takes a queued issue for its one Kit call: queued -> creating, stamped
 * with the time. False when another tick took it first.
 */
export async function claimIssue(db, id, { now = Date.now() } = {}) {
  const r = await db.execute({ sql: "UPDATE newsletter_issues SET status = 'creating', finished_at = ? WHERE id = ? AND status = 'queued'", args: [iso(now), id] });
  return r.rowsAffected > 0;
}

/** Records how an issue ended: scheduled or draft in Kit (with its id), stopped or skipped. */
export async function finishIssue(db, id, { status, reason = null, broadcastId = null, sendAt = null, now = Date.now() }) {
  await db.execute({
    sql: "UPDATE newsletter_issues SET status = ?, reason = ?, kit_broadcast_id = ?, send_at = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'creating')",
    args: [status, reason, broadcastId, sendAt, iso(now), id],
  });
}

/** Puts an issue back in the queue after a Kit call that certainly made nothing (a refusal before Kit stored anything). */
export async function requeueIssue(db, id, { reason }) {
  await db.execute({ sql: "UPDATE newsletter_issues SET status = 'queued', reason = ?, finished_at = NULL WHERE id = ? AND status = 'creating'", args: [reason, id] });
}

/**
 * Issues left in "creating" for CREATING_STUCK_MS: the tick ended between the
 * Kit call and its answer. They are stopped with a note to check Kit, never
 * retried, so a post can't be emailed twice. Returns how many.
 */
export async function stopStuckIssues(db, { now = Date.now() } = {}) {
  const r = await db.execute({
    sql: "UPDATE newsletter_issues SET status = 'stopped', reason = 'the Kit call never reported back: check Kit for this post', finished_at = ? WHERE status = 'creating' AND finished_at <= ?",
    args: [iso(now), iso(now - CREATING_STUCK_MS)],
  });
  return r.rowsAffected;
}

/** Recent issues for the admin: the post, state, Kit's broadcast id and when Kit sends it. */
export async function recentIssues(db, { limit = 10 } = {}) {
  const rows = (
    await db.execute({
      sql: `SELECT i.id, i.post_id, i.status, i.reason, i.created_at, i.finished_at, i.kit_broadcast_id, i.send_at, p.title, p.slug
            FROM newsletter_issues i LEFT JOIN posts p ON p.id = i.post_id
            ORDER BY i.created_at DESC LIMIT ?`,
      args: [limit],
    })
  ).rows;
  return rows.map((r) => ({
    id: String(r.id),
    postId: String(r.post_id),
    title: r.title == null ? "(deleted post)" : String(r.title),
    slug: r.slug == null ? null : String(r.slug),
    status: String(r.status),
    reason: r.reason == null ? null : String(r.reason),
    createdAt: String(r.created_at),
    finishedAt: r.finished_at == null ? null : String(r.finished_at),
    broadcastId: r.kit_broadcast_id == null ? null : String(r.kit_broadcast_id),
    sendAt: r.send_at == null ? null : String(r.send_at),
  }));
}
