// Tiers by ELO (lib/tiers.mjs) on the hourly Cron Trigger ("15 * * * *",
// worker/index.ts), incremental (owner decision 2026-11-13): votes move their
// two portfolios at once (lib/tiers-db.mjs applyFaceoff); here, once a day,
// the cutoffs are found and only the letters that changed are rewritten
// (dailyTiers: a few thousand rows read at most, never the whole library).
// The very first run, with no tier data yet, is the full rebuild
// (lib/tiers-store.mjs refreshTiers). No AI request.
//
// Profiles stay in the edge cache for a day (./edge-cache.ts), so the profiles
// whose letter changed are purged by their tag (profileTag), and every profile
// after a full rebuild.
import { db as database } from "../lib/db";
import { dailyDue, dailyTiers, readTierMeta } from "../lib/tiers-db.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";
import { PROFILES_TAG, profileTag } from "./edge-cache";
import { type PurgeTags, purgeProfilesOf } from "./tier-purge";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function tiersTick(scheduledTime: number, { purgeTags }: { purgeTags?: PurgeTags } = {}) {
  try {
    const db = database();
    const meta = await readTierMeta(db);
    if (!meta) {
      const r = await refreshTiers(db, { now: scheduledTime });
      if (purgeTags) await purgeTags([PROFILES_TAG]).catch(() => false);
      log("tiers.rebuild", { ...r });
      return r;
    }
    if (!dailyDue(meta, scheduledTime)) return { skipped: "not_due" };
    let purged = 0;
    const r = await dailyTiers(db, { now: scheduledTime, purge: async (urls: string[]) => void (purged = await purgeProfilesOf(urls, purgeTags, profileTag)) });
    log("tiers.daily", { ...r, purged });
    return { ...r, purged };
  } catch (e) {
    // Housekeeping: never fails the cron's other work; the next hour tries again.
    log("tiers.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { error: "failed" };
  }
}
