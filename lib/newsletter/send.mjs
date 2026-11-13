// Sending the newsletter (AUTOMATION.md "Newsletter"): each tick of the
// newsletter cron (worker/newsletter.ts, every 10 minutes while
// NEWSLETTER_ENABLED is "true") turns newly published posts into issues and
// each issue into one Kit broadcast (lib/newsletter/kit.mjs). Kit sends it
// to the confirmed subscribers and handles unsubscribes and bounces.
//
// Nothing happens while the owner's switch is off (lib/newsletter/switch.mjs).
//
// KIT_BROADCAST_MODE decides what the broadcast is:
//   "send"   scheduled SEND_DELAY_MS ahead (the V4 API has no "send now").
//            If Kit refuses to schedule (403, e.g. a plan or account
//            review limit), the same call is made as a draft instead.
//   "draft"  (the default, and always on staging) saved as a draft for the
//            owner to send from Kit.
// A draft sends the owner a one-line note, "draft ready in Kit".
//
// Never twice: an issue is claimed (queued -> creating) before its one Kit
// call. A refusal that certainly created nothing (429) puts it back in the
// queue; any other failure, or a call that never reported back, stops it
// with a note to check Kit, so a post is never sent twice.
import { postEmail } from "./emails.mjs";
import { claimIssue, finishIssue, queueIssues, queuedIssues, requeueIssue, stopStuckIssues } from "./store.mjs";
import { coverImage } from "./post.mjs";
import { readSwitch } from "./switch.mjs";

/** How far ahead a "send" broadcast is scheduled: time to pull it in Kit if something looks wrong. */
export const SEND_DELAY_MS = 10 * 60 * 1000;
/** Broadcasts a tick may create. */
export const ISSUES_PER_TICK = 3;

/** "send" or "draft" (anything else). */
export const broadcastMode = (raw) => (String(raw ?? "").trim().toLowerCase() === "send" ? "send" : "draft");

/** The email for one post: Kit's tags in the footer, or plain stand-ins for the admin's preview. */
export function emailForPost(post, { base, preview = false }) {
  const cover = coverImage(post, base);
  return postEmail({
    title: post.title,
    summary: post.newsletterBlurb ?? post.subtitle ?? null,
    url: `${base}/blog/${post.slug}`,
    image: cover?.src ?? null,
    imageAlt: cover?.alt ?? "",
    site: base,
    ...(preview ? { unsubscribeUrl: "#", address: "(your mailing address from Kit)" } : {}),
  });
}

/** Where a broadcast opens in Kit's app. */
export const kitBroadcastUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(String(id))}/draft`;

/**
 * The admin's "Create a test draft in Kit": the post's email as a draft
 * broadcast, marked [test] in its subject and description, never scheduled,
 * so it reaches nobody until the owner uses Kit's own "send test email" or
 * sends it by hand. Returns { id, url, subject }.
 * @param {{ createBroadcast: Function }} kit
 */
export async function createTestDraft(kit, post, { base }) {
  const mail = emailForPost(post, { base });
  const cover = coverImage(post, base);
  const subject = `[test] ${mail.subject}`;
  const made = await kit.createBroadcast({
    subject,
    content: mail.html,
    previewText: mail.previewText,
    description: `PortfolioRank test draft for ${post.slug}: sent to nobody. Use Send test email in Kit, then delete it.`,
    sendAt: null,
    thumbnailUrl: cover?.src ?? null,
    thumbnailAlt: cover?.alt ?? null,
  });
  return { id: made.id, url: kitBroadcastUrl(made.id), subject };
}

const short = (e) => String(e?.message ?? e).replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 160);

/**
 * One tick. Returns { queued, scheduled, drafts, stopped, waiting } where
 * waiting is a reason the queue was left alone (no Kit key), or null.
 * @param {{ db: any, kit: null | { createBroadcast: Function }, mode?: "send" | "draft", label?: string | null, base: string, now?: number, notify?: (line: string) => Promise<void>, log?: (event: string, data?: object) => void }} o
 */
export async function newsletterTick({ db, kit, mode = "draft", label = null, base, now = Date.now(), notify = async () => {}, log = () => {} }) {
  // The owner's switch is off: nothing is queued or created. Posts published
  // meanwhile stay marked, and only those under ISSUE_MAX_AGE_MS go out once
  // it is back on.
  if (!(await readSwitch(db)).on) return { queued: 0, scheduled: 0, drafts: 0, stopped: 0, waiting: "switched_off" };
  const stuck = await stopStuckIssues(db, { now });
  if (stuck) log("newsletter.stuck", { issues: stuck });
  const queued = await queueIssues(db, { now });
  const out = { queued: queued.length, scheduled: 0, drafts: 0, stopped: stuck, waiting: null };
  const issues = await queuedIssues(db);
  if (issues.length === 0) return out;
  if (!kit) return { ...out, waiting: "no_kit_key" };

  for (const issue of issues.slice(0, ISSUES_PER_TICK)) {
    // A post taken down before its broadcast was made: nothing goes out.
    if (issue.post.status !== "published") {
      await finishIssue(db, issue.id, { status: "stopped", reason: "the post was unpublished", now });
      out.stopped++;
      continue;
    }
    if (!(await claimIssue(db, issue.id, { now }))) continue;
    const mail = emailForPost(issue.post, { base });
    const cover = coverImage(issue.post, base);
    const broadcast = (sendAt) =>
      kit.createBroadcast({
        subject: label ? `[${label}] ${mail.subject}` : mail.subject,
        content: mail.html,
        previewText: mail.previewText,
        description: `PortfolioRank post ${issue.post.slug}${label ? ` (${label})` : ""}`,
        sendAt,
        thumbnailUrl: cover?.src ?? null,
        thumbnailAlt: cover?.alt ?? null,
      });

    let made = null;
    let note = null;
    try {
      if (mode === "send") {
        try {
          made = { ...(await broadcast(new Date(now + SEND_DELAY_MS).toISOString())), status: "scheduled" };
        } catch (e) {
          if (e?.status !== 403) throw e;
          note = `Kit refused to schedule it (${short(e)}); saved as a draft`;
          log("newsletter.schedule_refused", { issue: issue.id, error: short(e) });
        }
      }
      made ??= { ...(await broadcast(null)), status: "draft" };
    } catch (e) {
      if (e?.status === 429) {
        await requeueIssue(db, issue.id, { reason: "Kit asked us to slow down; trying again" });
        log("newsletter.kit_busy", { issue: issue.id });
        return out;
      }
      await finishIssue(db, issue.id, { status: "stopped", reason: `${short(e)}: check Kit before sending this post by hand`, now });
      log("newsletter.kit_failed", { issue: issue.id, error: short(e) });
      out.stopped++;
      continue;
    }

    await finishIssue(db, issue.id, { status: made.status, reason: note, broadcastId: made.id, sendAt: made.status === "scheduled" ? made.sendAt : null, now });
    log("newsletter.broadcast", { issue: issue.id, status: made.status, broadcast: made.id });
    if (made.status === "scheduled") out.scheduled++;
    else {
      out.drafts++;
      await notify(`${label ? `[${label}] ` : ""}Newsletter: draft ready in Kit for "${issue.post.title}".`).catch((e) => log("newsletter.note_failed", { error: short(e) }));
    }
  }
  return out;
}
