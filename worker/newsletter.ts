// The blog newsletter's tick (AUTOMATION.md "Newsletter"), on the five-minute cron (./index.ts):
// newly published posts become issues and each issue one Kit broadcast
// (lib/newsletter/send.mjs), scheduled or a draft by KIT_BROADCAST_MODE. A
// draft sends the owner a one-line note through the owner-alert email. It
// returns at once, before any database read, while NEWSLETTER_ENABLED is not
// "true" or there is no KIT_API_KEY. It calls no AI. An issue that stopped
// (Kit refused or never answered) is reported to the owner once a day
// (lib/newsletter/alerts.mjs); it is never retried.
import { db as database } from "../lib/db";
import { kitClient } from "../lib/newsletter/kit.mjs";
import { reconcileStoppedIssues } from "../lib/newsletter/alerts.mjs";
import { broadcastMode, newsletterTick as tick } from "../lib/newsletter/send.mjs";
import { emailSender } from "../pipeline/alerts.mjs";
import { testStandInsAllowed } from "../lib/test-mode.mjs";


export type NewsletterEnv = {
  NEWSLETTER_ENABLED?: string;
  SITE_URL: string;
  AUTH_SECRET?: string;
  SITE_ENV?: string;
  KIT_API_KEY?: string;
  KIT_TEST_API?: string;
  KIT_BROADCAST_MODE?: string;
  OWNER_EMAIL?: string;
  EMAIL_CAPS?: string;
};

const log = (event: string, data: object = {}) => console.log(JSON.stringify({ event, ...data }));

export async function newsletterTick(env: NewsletterEnv, scheduledTime: number) {
  if (!/^true$/i.test(String(env.NEWSLETTER_ENABLED ?? "")) || !env.KIT_API_KEY) return null;
  const db = database();
  try {
    const sender = emailSender(env, { db });
    const r = await tick({
      db,
      kit: kitClient({ apiKey: env.KIT_API_KEY, base: testStandInsAllowed(env) ? env.KIT_TEST_API : undefined }),
      mode: broadcastMode(env.KIT_BROADCAST_MODE),
      base: env.SITE_URL.replace(/\/$/, ""),
      now: scheduledTime,
      notify: async (line: string) => {
        if (!sender || !env.OWNER_EMAIL) return log("newsletter.note_not_sent", { line });
        await sender.send({ to: env.OWNER_EMAIL, subject: line, text: `${line}\n\nOpen Kit > Send > Broadcasts to review and send it.\n` });
      },
      log,
    });
    // An issue that stopped (Kit refused or never answered) is never retried, so the owner is told, once a day.
    await reconcileStoppedIssues(db, { now: scheduledTime, email: sender, to: env.OWNER_EMAIL ?? null, log: (line: string) => log("newsletter.alert", { line }) }).catch((e) =>
      log("newsletter.alert.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) })
    );
    if (r.queued || r.scheduled || r.drafts || r.stopped || r.waiting) log("newsletter.tick", r);
    return r;
  } catch (e) {
    // The next tick tries again; a claimed issue is never sent twice (lib/newsletter/send.mjs).
    log("newsletter.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
