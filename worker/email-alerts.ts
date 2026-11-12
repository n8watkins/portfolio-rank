// The email caps' owner alerts (lib/email/gate.mjs emailCapConditions), on
// the hourly Cron Trigger ("15 * * * *", worker/index.ts): once any kind of
// email, or the day's total, has used 80% of its cap, the owner hears about
// it (one email a day each, pipeline/alerts.mjs) while there is still room.
// The condition clears with the next quota day.
import { db as database } from "../lib/db";
import { emailCapConditions, emailCaps, isEmailCapAlert } from "../lib/email/gate.mjs";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function emailAlertsTick(env: NightEnv & { EMAIL_CAPS?: string }, scheduledTime: number) {
  const db = database();
  const now = new Date(scheduledTime);
  try {
    // Only the email-cap alerts are in scope here, so this never clears the night's.
    const r = await reconcileAlerts(db, {
      conditions: await emailCapConditions(db, { now, caps: emailCaps(env.EMAIL_CAPS) }),
      scope: isEmailCapAlert,
      now,
      email: emailSender(env, { db }),
      to: env.OWNER_EMAIL ?? null,
      log: (line: string) => log("email-alerts.alert", { line }),
    });
    if (r.active.length || r.cleared.length) log("email-alerts.tick", r);
    return r;
  } catch (e) {
    // Housekeeping: never fails the cron's other work; the next hour tries again.
    log("email-alerts.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
