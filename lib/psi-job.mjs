// A site's PageSpeed measure as the daily prewarm job does it, straight from
// the runner: take the site's lease, run each device's two runs (the two
// devices side by side), count every call, store each device's average with
// the store-if-better rule, give the lease back. The Worker never does this:
// a page view only reads what is stored (app/api/psi), and a visitor's speed
// check makes single runs (lib/tools/psi.ts). Plain JavaScript, no app imports.

import { releaseLease, takeLease } from "./cache-lease.mjs";
import { countPsiCall } from "./psi-calls.mjs";
import { RATE_LIMIT_WAITS_MS } from "./psi-pacing.mjs";
import { measureDevice } from "./psi-runs.mjs";
import { psiCacheKey, storeIfBetter } from "./psi-store.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `run` that, when a call comes back "rate_limited" (a per-minute limit),
 * waits and tries again after each of `waits`, then returns the last answer.
 * Any other answer, the daily "quota" included, is returned at once.
 */
export function withBackoff(run, { waits = RATE_LIMIT_WAITS_MS, sleep = defaultSleep } = {}) {
  return async (target, strategy) => {
    let r = await run(target, strategy);
    for (const wait of waits) {
      if (r?.ok || r?.error !== "rate_limited") break;
      await sleep(wait);
      r = await run(target, strategy);
    }
    return r;
  };
}

/**
 * Measures `devices` of one site and stores the results.
 * @param {{ execute: Function }} db
 * @param {string} url
 * @param {{ devices?: ("mobile" | "desktop")[], run: (target: string, strategy: "mobile" | "desktop") => Promise<any>, gapMs?: number, sleep?: (ms: number) => Promise<void>, waits?: number[] }} o
 * @returns {Promise<{ ok: true, measured: true } | { ok: false, error: string }>}
 *   measured: every device asked for stored a new good result. Else the error
 *   of the first device that failed ("quota" first: the day's quota is spent),
 *   "not_stored" when a result was good but a better stored one was kept, or
 *   "in_progress" when another worker holds the site.
 */
export async function measureAndStore(db, url, { devices = ["mobile", "desktop"], run, gapMs = 0, sleep = defaultSleep, waits = RATE_LIMIT_WAITS_MS }) {
  if (!(await takeLease(db, `psi:${url}`))) return { ok: false, error: "in_progress" };
  try {
    const call = withBackoff(async (target, strategy) => {
      await countPsiCall(db);
      return run(target, strategy);
    }, { waits, sleep });
    const results = await Promise.all(devices.map((d) => measureDevice(url, d, { run: call, gapMs, sleep })));
    const wrote = [];
    for (const [i, device] of devices.entries()) wrote.push(await storeIfBetter(db, psiCacheKey(device, url), results[i]));
    const failures = results.filter((r) => !r.ok);
    if (failures.length) return { ok: false, error: (failures.find((r) => r.error === "quota") ?? failures[0]).error ?? "unknown" };
    // A good result the store did not write (a fresher average of more runs is kept) is not a new result.
    if (wrote.includes(false)) return { ok: false, error: "not_stored" };
    return { ok: true, measured: true };
  } finally {
    await releaseLease(db, `psi:${url}`).catch(() => {});
  }
}
