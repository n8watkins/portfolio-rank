// The end-of-day run's dead-man check (pipeline/night-watch.mjs), on the
// hourly Cron Trigger ("15 * * * *", worker/index.ts): an owner alert when
// last night's run never started, or died and still says "running".
import * as Sentry from "@sentry/cloudflare";
import { db as database } from "../lib/db";
import { budgetPlan } from "../pipeline/budget.mjs";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { isNightWatchAlert, nightWatchConditions } from "../pipeline/night-watch.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function nightWatchTick(env: NightEnv, scheduledTime: number) {
  const db = database();
  const now = new Date(scheduledTime);
  try {
    const conditions = await nightWatchConditions(db, {
      now,
      plan: budgetPlan(env.GEMINI_BUDGET),
      instanceStatus: async (id: string) => (await (await env.NIGHT.get(id)).status()).status,
    });
    // Only the dead-man alerts are in scope here, so this never clears the night's own.
    const r = await reconcileAlerts(db, {
      conditions,
      scope: isNightWatchAlert,
      now,
      email: emailSender(env, { db }),
      to: env.OWNER_EMAIL ?? null,
      log: (line: string) => log("night-watch.alert", { line }),
    });
    if (r.active.length || r.cleared.length) log("night-watch.tick", r);
    return r;
  } catch (e) {
    // Never fails the cron's other work; the next hour tries again, and
    // Sentry hears about it so a broken watch is not silent too.
    Sentry.captureException(e);
    log("night-watch.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
