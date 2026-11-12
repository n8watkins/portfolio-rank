// Owners' held removals (lib/games/claims.mjs), on the hourly Cron Trigger
// ("15 * * * *", worker/index.ts): a removal whose 24 hours are up takes
// effect, and every removal still held is an owner alert (one email a day
// each, pipeline/alerts.mjs), so the site's owner hears about it while it
// can still be undone (/api/admin/removals).
import { db as database } from "../lib/db";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { applyDueRemovals, isRemovalAlert, removalConditions } from "../lib/games/claims.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function removalsTick(env: NightEnv, scheduledTime: number) {
  const db = database();
  const now = new Date(scheduledTime);
  try {
    const applied = await applyDueRemovals(db, { now });
    // The quiz pool leaves out removed sites.
    if (applied.length) await db.execute({ sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] });
    // Only the removal alerts are in scope here, so this never clears the night's.
    const alerts = await reconcileAlerts(db, {
      conditions: await removalConditions(db),
      scope: isRemovalAlert,
      now,
      email: emailSender(env, { db }),
      to: env.OWNER_EMAIL ?? null,
      log: (line: string) => log("removals.alert", { line }),
    });
    if (applied.length || alerts.active.length || alerts.cleared.length) log("removals.tick", { applied: applied.length, alerts });
    return { applied, alerts };
  } catch (e) {
    // Housekeeping: never fails the cron's other work; the next hour tries again.
    log("removals.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { applied: [], error: "failed" };
  }
}
