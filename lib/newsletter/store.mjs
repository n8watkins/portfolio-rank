// The blog newsletter's subscribers and issues (lib/newsletter/schema.mjs,
// AUTOMATION.md "Newsletter").
//
// Double opt-in: signing up stores the address as "pending" with a confirm
// link (256 random bits, only its SHA-256 kept, 3 days to live); only the
// link makes it "confirmed", and only confirmed addresses get posts.
// Unsubscribing needs no sign-in: every email carries a link with the
// subscriber's random id and a keyed hash of it (unsubKey), which works for
// one-click unsubscribes (RFC 8058) too. We store the address, its status,
// the times and the page it signed up on, nothing else; unconfirmed rows go
// after 7 days and unsubscribed ones 30 days after the unsubscribe.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { addressHash } from "../email/gate.mjs";
import { postFromRow } from "../content/store.mjs";

export const CONFIRM_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** Unconfirmed sign-ups are deleted this long after they were made. */
export const PENDING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Unsubscribed addresses are deleted this long after the unsubscribe. */
export const UNSUBSCRIBED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** A post published longer ago than this when the newsletter first sees it is not emailed (a backlog never goes out at once). */
export const ISSUE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();
const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** Where someone signed up, as stored: a same-site path (no query) and the form, e.g. "/blog/x (sidebar)". */
export function cleanSource(path, form) {
  const p = String(path ?? "").split(/[?#]/)[0];
  const safe = p.startsWith("/") && !p.startsWith("//") && p.length <= 160 && /^[\x21-\x7e]+$/.test(p) ? p : null;
  const f = ["sidebar", "after-post", "blog", "footer"].includes(String(form)) ? String(form) : null;
  if (!safe && !f) return null;
  return [safe ?? "?", f ? `(${f})` : null].filter(Boolean).join(" ");
}

/** The unsubscribe key for a subscriber id: a keyed hash, so a link can't be made for someone else. */
export function unsubKey(id, secret) {
  return createHmac("sha256", String(secret ?? "")).update(`newsletter-unsub\n${id}`).digest("base64url").slice(0, 32);
}

export function validUnsub(id, key, secret) {
  if (!ID_RE.test(String(id ?? "")) || typeof key !== "string" || key.length !== 32) return false;
  const want = Buffer.from(unsubKey(id, secret));
  const got = Buffer.from(key);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Signs an address up (or again). A new, pending or unsubscribed address
 * becomes pending with a fresh confirm link: { action: "confirm", id, token }.
 * An address that is already confirmed is left as it is: { action: "none" }.
 * @param {any} db
 * @param {{ email: string, source?: string | null, now?: number, secret?: string }} options
 */
export async function subscribe(db, { email, source = null, now = Date.now(), secret }) {
  const token = randomBytes(32).toString("base64url");
  const row = (
    await db.execute({
      sql: `INSERT INTO newsletter_subscribers (id, email, email_hash, status, source, created_at, confirm_hash, confirm_expires_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
            ON CONFLICT(email_hash) DO UPDATE SET
              source = CASE WHEN status = 'confirmed' THEN source ELSE COALESCE(excluded.source, source) END,
              created_at = CASE WHEN status = 'unsubscribed' THEN excluded.created_at ELSE created_at END,
              unsubscribed_at = CASE WHEN status = 'confirmed' THEN unsubscribed_at ELSE NULL END,
              confirm_hash = CASE WHEN status = 'confirmed' THEN NULL ELSE excluded.confirm_hash END,
              confirm_expires_at = CASE WHEN status = 'confirmed' THEN NULL ELSE excluded.confirm_expires_at END,
              status = CASE WHEN status = 'confirmed' THEN 'confirmed' ELSE 'pending' END
            RETURNING id, status, confirm_hash`,
      args: [randomBytes(12).toString("base64url"), email, addressHash(email, secret), source, iso(now), hashToken(token), iso(now + CONFIRM_TTL_MS)],
    })
  ).rows[0];
  if (String(row.status) === "confirmed") return { action: "none", id: String(row.id) };
  return { action: "confirm", id: String(row.id), token };
}

/** What a confirm link would do, without using it: { email } or { error: "invalid" | "expired" }. */
export async function peekConfirm(db, token, { now = Date.now() } = {}) {
  if (!TOKEN_RE.test(String(token ?? ""))) return { error: "invalid" };
  const r = (await db.execute({ sql: "SELECT email, confirm_expires_at FROM newsletter_subscribers WHERE confirm_hash = ? AND status = 'pending'", args: [hashToken(token)] })).rows[0];
  if (!r) return { error: "invalid" };
  if (String(r.confirm_expires_at) <= iso(now)) return { error: "expired" };
  return { email: String(r.email) };
}

/** Uses a confirm link (once): { ok: true, email } or { error: "invalid" | "expired" }. */
export async function confirmSubscription(db, token, { now = Date.now() } = {}) {
  if (!TOKEN_RE.test(String(token ?? ""))) return { error: "invalid" };
  const r = (
    await db.execute({
      sql: `UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = ?, confirm_hash = NULL, confirm_expires_at = NULL
            WHERE confirm_hash = ? AND status = 'pending' AND confirm_expires_at > ? RETURNING email`,
      args: [iso(now), hashToken(token), iso(now)],
    })
  ).rows[0];
  if (r) return { ok: true, email: String(r.email) };
  const peek = await peekConfirm(db, token, { now });
  return { error: "error" in peek ? peek.error : "invalid" };
}

/**
 * Unsubscribes by the link in an email. Always { ok: true } for a valid key,
 * even when the address is already unsubscribed or deleted; { error:
 * "invalid" } otherwise.
 */
export async function unsubscribe(db, { id, key, secret, now = Date.now() }) {
  if (!validUnsub(id, key, secret)) return { error: "invalid" };
  await db.execute({
    sql: `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?), confirm_hash = NULL, confirm_expires_at = NULL
          WHERE id = ?`,
    args: [iso(now), id],
  });
  return { ok: true };
}

/** Retention: unconfirmed sign-ups after 7 days, unsubscribed addresses 30 days after the unsubscribe, with their delivery rows. */
export async function pruneNewsletter(db, { now = Date.now() } = {}) {
  const gone = `SELECT id FROM newsletter_subscribers WHERE (status = 'pending' AND created_at <= ?) OR (status = 'unsubscribed' AND unsubscribed_at <= ?)`;
  const args = [iso(now - PENDING_KEEP_MS), iso(now - UNSUBSCRIBED_KEEP_MS)];
  const res = await db.batch(
    [
      { sql: `DELETE FROM newsletter_deliveries WHERE subscriber_id IN (${gone})`, args },
      { sql: `DELETE FROM newsletter_subscribers WHERE id IN (${gone})`, args },
    ],
    "write"
  );
  return res[1].rowsAffected;
}

/** Subscribers by status: { confirmed, pending, unsubscribed }. */
export async function newsletterCounts(db) {
  const rows = (await db.execute("SELECT status, COUNT(*) AS n FROM newsletter_subscribers GROUP BY status")).rows;
  const out = { confirmed: 0, pending: 0, unsubscribed: 0 };
  for (const r of rows) if (String(r.status) in out) out[String(r.status)] = Number(r.n);
  return out;
}

/** The list for the admin, newest sign-up first. */
export async function listSubscribers(db, { limit = 500 } = {}) {
  const rows = (
    await db.execute({
      sql: "SELECT id, email, status, source, created_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers ORDER BY created_at DESC, id LIMIT ?",
      args: [limit],
    })
  ).rows;
  return rows.map((r) => ({
    id: String(r.id),
    email: String(r.email),
    status: String(r.status),
    source: r.source == null ? null : String(r.source),
    createdAt: String(r.created_at),
    confirmedAt: r.confirmed_at == null ? null : String(r.confirmed_at),
    unsubscribedAt: r.unsubscribed_at == null ? null : String(r.unsubscribed_at),
  }));
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
          args: [id, String(p.id), old ? "skipped" : "sending", old ? "published too long ago" : null, iso(now), old ? iso(now) : null],
        },
        { sql: "UPDATE posts SET newsletter_pending = 0 WHERE id = ?", args: [String(p.id)] },
      ],
      "write"
    );
    if (res[0].rowsAffected > 0) out.push({ id, postId: String(p.id), status: old ? "skipped" : "sending" });
  }
  return out;
}

/** Issues still sending, oldest first, with their post. */
export async function sendingIssues(db) {
  const rows = (
    await db.execute(
      "SELECT i.id AS issue_id, i.created_at AS issue_created_at, p.* FROM newsletter_issues i JOIN posts p ON p.id = i.post_id WHERE i.status = 'sending' ORDER BY i.created_at"
    )
  ).rows;
  return rows.map((r) => ({ id: String(r.issue_id), createdAt: String(r.issue_created_at), post: postFromRow(r) }));
}

/** The next confirmed subscribers an issue hasn't reached: those confirmed before it was queued. */
export async function nextRecipients(db, issue, { limit }) {
  const rows = (
    await db.execute({
      sql: `SELECT s.id, s.email FROM newsletter_subscribers s
            WHERE s.status = 'confirmed' AND s.confirmed_at <= ?
              AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries d WHERE d.issue_id = ? AND d.subscriber_id = s.id)
            ORDER BY s.confirmed_at, s.id LIMIT ?`,
      args: [issue.createdAt, issue.id, limit],
    })
  ).rows;
  return rows.map((r) => ({ id: String(r.id), email: String(r.email) }));
}

export async function recordDelivery(db, { issueId, subscriberId, status, reason = null, now = Date.now() }) {
  await db.execute({
    sql: "INSERT INTO newsletter_deliveries (issue_id, subscriber_id, status, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [issueId, subscriberId, status, reason, iso(now)],
  });
}

export async function finishIssue(db, id, { status = "sent", reason = null, now = Date.now() } = {}) {
  await db.execute({ sql: "UPDATE newsletter_issues SET status = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'sending'", args: [status, reason, iso(now), id] });
}

/** Recent issues for the admin: the post, state, sent and failed counts, and how many are still to go. */
export async function recentIssues(db, { limit = 10 } = {}) {
  const rows = (
    await db.execute({
      sql: `SELECT i.id, i.post_id, i.status, i.reason, i.created_at, i.finished_at, p.title, p.slug,
              (SELECT COUNT(*) FROM newsletter_deliveries d WHERE d.issue_id = i.id AND d.status = 'sent') AS sent,
              (SELECT COUNT(*) FROM newsletter_deliveries d WHERE d.issue_id = i.id AND d.status = 'failed') AS failed,
              CASE WHEN i.status = 'sending' THEN (SELECT COUNT(*) FROM newsletter_subscribers s WHERE s.status = 'confirmed' AND s.confirmed_at <= i.created_at
                AND NOT EXISTS (SELECT 1 FROM newsletter_deliveries d WHERE d.issue_id = i.id AND d.subscriber_id = s.id)) ELSE 0 END AS waiting
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
    sent: Number(r.sent),
    failed: Number(r.failed),
    waiting: Number(r.waiting),
  }));
}
