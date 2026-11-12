// Sending the newsletter (AUTOMATION.md "Newsletter"): each tick of the
// newsletter cron (worker/newsletter.ts, every 10 minutes while
// NEWSLETTER_ENABLED is "true") turns newly published posts into issues and
// sends the next batch of one issue, through the shared email gate (kind
// "newsletter", its daily caps) and the newsletter's mailroom app (its own
// daily and monthly caps and the account's).
//
// Fails closed: a cap, a missing transport, a paused or unknown mailroom app
// or any error that isn't about one address stops the tick and leaves the
// rest for a later one, so a full day waits for the next day and nothing
// ever goes past a cap. A send that mailroom refuses for one address
// (suppressed after a bounce, invalid) is recorded as failed and the batch
// goes on. Each email has an idempotency key per issue and subscriber, so a
// retry never sends twice.
import { postEmail } from "./emails.mjs";
import { finishIssue, nextRecipients, pruneNewsletter, queueIssues, recordDelivery, sendingIssues, unsubKey } from "./store.mjs";
import { coverImage } from "./post.mjs";

/** Emails a tick may send (every 10 minutes: at most 60 an hour, inside the day's caps). */
export const NEWSLETTER_BATCH = 10;

/** Mailroom refusals about one address: the batch goes on without it. */
const ONE_ADDRESS = /mailroom refused: (suppressed|invalid|cap_recipient|rejected)\b/;

export const unsubscribeUrl = (base, id, secret) => `${base}/api/newsletter/unsubscribe?s=${encodeURIComponent(id)}&k=${unsubKey(id, secret)}`;

/** The email for one post, for one subscriber (or the owner's test). */
export function emailForPost(post, { base, unsubscribe, test = false }) {
  const cover = coverImage(post, base);
  return postEmail({
    title: post.title,
    summary: post.newsletterBlurb ?? post.subtitle ?? null,
    url: `${base}/blog/${post.slug}`,
    image: cover?.src ?? null,
    imageAlt: cover?.alt ?? "",
    unsubscribeUrl: unsubscribe,
    site: base,
    test,
  });
}

/**
 * One tick. Returns what it did: { queued, sent, failed, stopped } where
 * stopped is null or the reason the tick stopped early.
 * @param {{ db: any, gate: { enabled: boolean, send: Function }, base: string, secret: string, now?: number, batch?: number, log?: (event: string, data?: object) => void }} o
 */
export async function newsletterTick({ db, gate, base, secret, now = Date.now(), batch = NEWSLETTER_BATCH, log = () => {} }) {
  const pruned = await pruneNewsletter(db, { now });
  if (pruned) log("newsletter.pruned", { rows: pruned });
  const queued = await queueIssues(db, { now });
  const out = { queued: queued.length, sent: 0, failed: 0, stopped: null };
  const issues = await sendingIssues(db);
  for (const issue of issues) {
    if (out.sent + out.failed >= batch) break;
    // A post taken down while its issue was going out: the rest is not sent.
    if (issue.post.status !== "published") {
      await finishIssue(db, issue.id, { status: "stopped", reason: "the post was unpublished", now });
      continue;
    }
    if (!gate.enabled) return { ...out, stopped: "no_transport" };
    const to = await nextRecipients(db, issue, { limit: batch - out.sent - out.failed });
    if (to.length === 0) {
      await finishIssue(db, issue.id, { status: "sent", now });
      log("newsletter.issue_sent", { issue: issue.id });
      continue;
    }
    for (const s of to) {
      const mail = emailForPost(issue.post, { base, unsubscribe: unsubscribeUrl(base, s.id, secret) });
      const r = await gate.send({ kind: "newsletter", to: s.email, ...mail, key: `nl-${issue.id}-${s.id}` });
      if (r.sent) {
        await recordDelivery(db, { issueId: issue.id, subscriberId: s.id, status: "sent", now });
        out.sent++;
        continue;
      }
      const reason = String(r.reason ?? "unknown");
      if (reason === "bad_address" || reason === "cap:recipient" || ONE_ADDRESS.test(reason)) {
        await recordDelivery(db, { issueId: issue.id, subscriberId: s.id, status: "failed", reason: reason.slice(0, 120), now });
        out.failed++;
        continue;
      }
      log("newsletter.stopped", { issue: issue.id, reason: reason.slice(0, 120) });
      return { ...out, stopped: reason.slice(0, 120) };
    }
  }
  return out;
}
