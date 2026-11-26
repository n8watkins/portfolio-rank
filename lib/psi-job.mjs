// A site's PageSpeed measure as the daily prewarm job does it, straight from
// the runner: take the site's lease, run each device's two runs (the two
// devices side by side), count every call, store each device's average with
// the store-if-better rule, give the lease back. The Worker never does this:
// a page view only reads what is stored (app/api/psi), and a visitor's speed
// check makes single runs (lib/tools/psi.ts). Plain JavaScript, no app imports.

import { releaseLease, takeLease } from "./cache-lease.mjs";
import { clearAttempts, countPsiCall, recordFailedAttempt } from "./psi-calls.mjs";
import { RATE_LIMIT_WAITS_MS } from "./psi-pacing.mjs";
import { measureDevice } from "./psi-runs.mjs";
import { psiCacheKey, storeIfBetter } from "./psi-store.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Errors that say nothing about the site.
const NOT_THE_SITE = new Set(["quota", "rate_limited", "api_key"]);

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
 *   of the first device that failed ("api_key", then "quota", first: nothing
 *   more can be measured), which also notes a failed try against the site and
 *   device (psi_attempts) unless the error is not about the site,
 *   "not_stored" when a result was good but a better stored one was kept, or
 *   "in_progress" when another worker holds the site.
 */
export async function measureAndStore(db, url, { devices = ["mobile", "desktop"], run, gapMs = 0, sleep = defaultSleep, waits = RATE_LIMIT_WAITS_MS, now = Date.now }) {
  if (!(await takeLease(db, `psi:${url}`))) return { ok: false, error: "in_progress" };
  try {
    const call = withBackoff(async (target, strategy) => {
      await countPsiCall(db);
      return run(target, strategy);
    }, { waits, sleep });
    const results = await Promise.all(devices.map((d) => measureDevice(url, d, { run: call, gapMs, sleep })));
    const errors = [];
    for (const [i, device] of devices.entries()) {
      const r = results[i];
      // Not about the site (the day's quota, a per-minute limit, a bad key): nothing is stored for the site and no
      // try is noted against it; the job stops or goes on, and the site is tried again at its turn.
      if (!r.ok && NOT_THE_SITE.has(r.error)) {
        errors.push(r.error);
        continue;
      }
      const wrote = await storeIfBetter(db, psiCacheKey(device, url), r);
      if (r.ok && wrote) {
        await clearAttempts(db, url, device);
      } else {
        // No new stored result (a failed measure, or a good one that did not replace a better stored result):
        // one more failure in a row, which spaces the next try out (lib/psi-pacing.mjs backoffMs).
        await recordFailedAttempt(db, url, device, now());
        errors.push(r.ok ? "not_stored" : (r.error ?? "unknown"));
      }
    }
    if (errors.length) return { ok: false, error: ["api_key", "quota"].find((e) => errors.includes(e)) ?? errors[0] };
    return { ok: true, measured: true };
  } finally {
    await releaseLease(db, `psi:${url}`).catch(() => {});
  }
}
