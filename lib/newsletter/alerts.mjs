// Owner alerts for a newsletter issue that stopped (lib/newsletter/send.mjs):
// Kit answered with an error, or a Kit call never reported back, so the
// issue is "stopped" for good (never retried, so a post can't be mailed
// twice) and its post is not emailed. The owner is told through the same
// alert mechanism as the night's alerts (pipeline/alerts.mjs
// reconcileAlerts): one email per stopped issue per day, naming the post and
// the reason, until the issue is STOPPED_ALERT_DAYS old and the alert clears.
//
// A post the owner took down before its broadcast was made also ends as
// "stopped" (reason UNPUBLISHED_REASON); that was their own choice, so it is
// not an alert.
import { reconcileAlerts } from "../../pipeline/alerts.mjs";

/** Alert key prefix: reconcileAlerts' scope, so only these alerts are cleared by this check. */
export const NEWSLETTER_ALERT = "newsletter-stopped:";
export const isNewsletterAlert = (key) => String(key).startsWith(NEWSLETTER_ALERT);
/** How long a stopped issue keeps reminding the owner, in days. */
export const STOPPED_ALERT_DAYS = 7;
/** The reason send.mjs gives an issue whose post was unpublished (no alert). */
export const UNPUBLISHED_REASON = "the post was unpublished";

/**
 * One problem condition for each issue that stopped in the last
 * STOPPED_ALERT_DAYS days, except for an unpublished post.
 * @param {any} db
 * @param {{ now?: number }} [options]
 */
export async function stoppedIssueConditions(db, { now = Date.now() } = {}) {
  const since = new Date(now - STOPPED_ALERT_DAYS * 86400000).toISOString();
  const rows = (
    await db.execute({
      sql: `SELECT i.id, i.reason, i.finished_at, p.title, p.slug
            FROM newsletter_issues i LEFT JOIN posts p ON p.id = i.post_id
            WHERE i.status = 'stopped' AND i.finished_at >= ? AND COALESCE(i.reason, '') <> ?
            ORDER BY i.finished_at`,
      args: [since, UNPUBLISHED_REASON],
    })
  ).rows;
  return rows.map((r) => {
    const name = r.title == null ? "a deleted post" : `"${String(r.title)}"`;
    return {
      key: `${NEWSLETTER_ALERT}${String(r.id)}`,
      kind: "problem",
      title: `Newsletter: ${name} was not emailed`,
      detail:
        `The newsletter issue for ${name}${r.slug ? ` (/blog/${String(r.slug)})` : ""} stopped on ${String(r.finished_at).slice(0, 16).replace("T", " ")} UTC and was not sent.\n` +
        `Reason: ${String(r.reason ?? "unknown")}.\n` +
        "It is never retried automatically, because Kit may already have a broadcast for it. Check Kit > Send > Broadcasts; if nothing is there, send the post by hand.",
    };
  });
}

/**
 * Records and emails the stopped-issue alerts (one email per issue per day).
 * @param {any} db
 * @param {{ now?: number, email?: null | { send: Function }, to?: string | null, log?: (line: string) => void }} [options]
 */
export async function reconcileStoppedIssues(db, { now = Date.now(), email = null, to = null, log = () => {} } = {}) {
  return reconcileAlerts(db, { conditions: await stoppedIssueConditions(db, { now }), scope: isNewsletterAlert, now: new Date(now), email, to, log });
}
