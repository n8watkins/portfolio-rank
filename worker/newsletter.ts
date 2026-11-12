// The blog newsletter's cron (AUTOMATION.md "Newsletter"): every 10 minutes,
// newly published posts become issues and the next batch of up to 10 emails
// goes out (lib/newsletter/send.mjs), through the shared email gate and the
// newsletter's mailroom app (MAILROOM_NEWS, app "portfoliorank-news"). It
// returns at once while NEWSLETTER_ENABLED is not "true". It calls no AI, so
// staging runs it too.
import { db as database } from "../lib/db";
import { createEmailGate, emailCaps, emailTransport } from "../lib/email/gate.mjs";
import { newsletterTick as tick } from "../lib/newsletter/send.mjs";

export const NEWSLETTER_CRON = "*/10 * * * *";

export type NewsletterEnv = {
  NEWSLETTER_ENABLED?: string;
  AUTH_URL: string;
  AUTH_SECRET?: string;
  EMAIL_CAPS?: string;
  MAILROOM_NEWS?: unknown;
};

const log = (event: string, data: object = {}) => console.log(JSON.stringify({ event, ...data }));

export async function newsletterTick(env: NewsletterEnv, scheduledTime: number) {
  if (!/^true$/i.test(String(env.NEWSLETTER_ENABLED ?? ""))) return null;
  const db = database();
  const secret = String(env.AUTH_SECRET ?? process.env.AUTH_SECRET ?? "");
  try {
    const gate = createEmailGate({
      db,
      transport: emailTransport(env, { db, via: "mailroom-news" }),
      caps: emailCaps(env.EMAIL_CAPS),
      secret,
      log: (line: string) => log("newsletter.gate", { line }),
    });
    const r = await tick({ db, gate, base: env.AUTH_URL.replace(/\/$/, ""), secret, now: scheduledTime, log });
    if (r.queued || r.sent || r.failed || r.stopped) log("newsletter.tick", r);
    return r;
  } catch (e) {
    // The next tick tries again; nothing was sent past a cap.
    log("newsletter.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
