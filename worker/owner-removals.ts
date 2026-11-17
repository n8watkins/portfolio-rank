// Owners' held removals (lib/games/claims.mjs), on the hourly Cron Trigger
// ("15 * * * *", worker/index.ts): a removal whose 24 hours are up takes
// effect, and every removal still held (or cancelled in the last day) is an
// owner alert (one email a day each, pipeline/alerts.mjs), so the site's
// owner hears about it while it can still be undone (/api/admin/removals).
// Each step runs on its own: an alert that fails never hides a removal that
// already took effect. The edge purge of removed profiles is the hourly
// "edge purge" task's (worker/index.ts purgeAfterHour), which reads what is
// still unpurged from the database (purgeRemovedProfiles), so it doesn't
// depend on what this tick returns either.
import { db as database } from "../lib/db";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { applyDueRemovals, isRemovalAlert, removalConditions } from "../lib/games/claims.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export async function removalsTick(env: NightEnv, scheduledTime: number) {
  const db = database();
  const now = new Date(scheduledTime);
  const failed: string[] = [];
  // Housekeeping: a failed step never fails the cron's other work; the next hour tries again.
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (e) {
      failed.push(name);
      log("removals.tick.failed", { step: name, error: message(e) });
      return undefined;
    }
  };
  const applied = (await step("apply", () => applyDueRemovals(db, { now }))) ?? [];
  // The quiz pool leaves out removed sites.
  if (applied.length) await step("pool", () => db.execute({ sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] }));
  // Only the removal alerts are in scope here, so this never clears the night's.
  const alerts = await step("alerts", async () =>
    reconcileAlerts(db, {
      conditions: await removalConditions(db, { now }),
      scope: isRemovalAlert,
      now,
      email: emailSender(env, { db }),
      to: env.OWNER_EMAIL ?? null,
      log: (line: string) => log("removals.alert", { line }),
    })
  );
  if (applied.length || alerts?.active.length || alerts?.cleared.length) log("removals.tick", { applied: applied.length, alerts });
  return { applied, alerts: alerts ?? null, ...(failed.length ? { error: "failed", failed } : {}) };
}
