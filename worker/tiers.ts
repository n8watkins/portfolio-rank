// Tiers by ELO (lib/tiers.mjs), on the hourly Cron Trigger ("15 * * * *",
// worker/index.ts): every face-off is replayed and every graded portfolio's
// tier placed again (lib/tiers-store.mjs refreshTiers). No AI request: a read
// of the grades and the votes, and a write of the ranks that changed.
import { db as database } from "../lib/db";
import { refreshTiers } from "../lib/tiers-store.mjs";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function tiersTick(scheduledTime: number) {
  try {
    const r = await refreshTiers(database(), { now: scheduledTime });
    if (r.updated || r.cleared || r.jobs) log("tiers.tick", { ...r });
    return r;
  } catch (e) {
    // Housekeeping: never fails the cron's other work; the next hour tries again.
    log("tiers.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { error: "failed" };
  }
}
