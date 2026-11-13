// The blog newsletter's cron (AUTOMATION.md "Newsletter"): every 10 minutes,
// newly published posts become issues and each issue one Kit broadcast
// (lib/newsletter/send.mjs), scheduled or a draft by KIT_BROADCAST_MODE. A
// draft sends the owner a one-line note through the owner-alert email. It
// returns at once while NEWSLETTER_ENABLED is not "true", and leaves the
// queue alone without KIT_API_KEY. It calls no AI, so staging runs it too;
// staging only ever makes drafts, marked [staging].
import { db as database } from "../lib/db";
import { kitClient } from "../lib/newsletter/kit.mjs";
import { broadcastMode, newsletterTick as tick } from "../lib/newsletter/send.mjs";
import { emailSender } from "../pipeline/alerts.mjs";

export const NEWSLETTER_CRON = "*/10 * * * *";

export type NewsletterEnv = {
  NEWSLETTER_ENABLED?: string;
  SITE_URL?: string;
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
  if (!/^true$/i.test(String(env.NEWSLETTER_ENABLED ?? ""))) return null;
  const db = database();
  const staging = env.SITE_ENV === "staging";
  try {
    const sender = emailSender(env, { db });
    const r = await tick({
      db,
      kit: kitClient({ apiKey: env.KIT_API_KEY, base: env.SITE_ENV === "production" || staging ? undefined : env.KIT_TEST_API }),
      // Staging shares the owner's one Kit account with production: drafts only.
      mode: staging ? "draft" : broadcastMode(env.KIT_BROADCAST_MODE),
      label: staging ? "staging" : null,
      base: String(env.SITE_URL ?? "").replace(/\/$/, ""),
      now: scheduledTime,
      notify: async (line: string) => {
        if (!sender || !env.OWNER_EMAIL) return log("newsletter.note_not_sent", { line });
        await sender.send({ to: env.OWNER_EMAIL, subject: line, text: `${line}\n\nOpen Kit > Send > Broadcasts to review and send it.\n` });
      },
      log,
    });
    if (r.queued || r.scheduled || r.drafts || r.stopped || r.waiting) log("newsletter.tick", r);
    return r;
  } catch (e) {
    // The next tick tries again; a claimed issue is never sent twice (lib/newsletter/send.mjs).
    log("newsletter.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
