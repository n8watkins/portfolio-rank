// Owners' held removals (lib/games/claims.mjs), on the hourly Cron Trigger
// ("15 * * * *", worker/index.ts), as two hourly tasks that run on their own
// (pipeline/hourly.mjs runEach reports a failure to Sentry and the next task
// still runs): a removal whose 24 hours are up takes effect, and every
// removal still held is an owner alert (one email a day each,
// pipeline/alerts.mjs), so the site's owner hears about it while it can still
// be undone (/api/admin/removals). A cancel sends no alert by itself.
// The edge purge of removed profiles is the hourly "edge purge" task's
// (worker/index.ts purgeAfterHour), which reads what is still unpurged from
// the database (purgeRemovedProfiles), so it doesn't depend on these tasks.
import { db as database, ensureSchema } from "../lib/db";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { applyDueRemovals, isRemovalAlert, removalConditions } from "../lib/games/claims.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

/** Removals whose hold is up take effect (each drops the cached quiz pool in its own transaction). Returns the urls. */
export async function applyRemovalsTick(scheduledTime: number) {
  // The hourly cron may run before a deploy's migration (portfolio_owner.purged_at).
  await ensureSchema();
  const applied = await applyDueRemovals(database(), { now: new Date(scheduledTime) });
  if (applied.length) log("removals.applied", { applied: applied.length });
  return applied;
}

/** The owner alert for every removal still held; only the removal alerts are in scope, so this never clears the night's. */
export async function removalAlertsTick(env: NightEnv, scheduledTime: number) {
  await ensureSchema();
  const db = database();
  const now = new Date(scheduledTime);
  const alerts = await reconcileAlerts(db, {
    conditions: await removalConditions(db, { now }),
    scope: isRemovalAlert,
    now,
    email: emailSender(env, { db }),
    to: env.OWNER_EMAIL ?? null,
    log: (line: string) => log("removals.alert", { line }),
  });
  if (alerts.active.length || alerts.cleared.length) log("removals.alerts", { alerts });
  return alerts;
}
