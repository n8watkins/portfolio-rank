// The arithmetic behind how fast the daily prewarm may call PageSpeed (pure).
// A site's measure is four Lighthouse runs (two phone, two desktop,
// lib/psi-runs.mjs), so the schedule is checked against Google's two limits
// and against the job's own time box.

import { RUNS_PER_DEVICE } from "./psi-runs.mjs";

/** Runs a site's measure makes: two per device, two devices. */
export const RUNS_PER_SITE = RUNS_PER_DEVICE * 2;
/** PageSpeed's quota for a key in a project without billing: runs a day, refused after (no charge). */
export const PSI_DAILY_CAP = 25_000;
/** The per-minute limit assumed for the PageSpeed API (from memory, NOT confirmed from a Google page). Check it in the Google Cloud console quota view before relying on it. */
export const PSI_PER_MINUTE_CAP = 240;
/** How long one PageSpeed call takes (seconds): an estimate from the old prewarm comment ("about 25 s a site"), never measured here. */
export const SECONDS_PER_RUN = 25;
/** The wait between a device's first and second run (ms). A precaution so the two runs are not the same one; it is NOT based on a documented PageSpeed rule. Unverified until scripts/experiments/psi-two-runs.mjs has been run with a key. averageRuns also counts two runs with the same `fetchTime` as one. */
export const DEFAULT_RUN_GAP_MS = 30_000;
/** Sites the daily prewarm measures at once (each makes up to two device runs at the same time). */
export const PREWARM_CONCURRENCY = 3;
/** A listed site's Lighthouse result is measured again after this many days (lib/freshness.mjs). */
export const REMEASURE_DAYS = 90;

/**
 * What a schedule costs.
 * @param {{ sites: number, perDay?: number, concurrency?: number, runGapMs?: number, secondsPerRun?: number }} o
 *   sites: sites measured in the day; concurrency: sites in flight at once
 * @returns {{ runsPerDay: number, shareOfDailyCap: number, secondsPerSite: number, hours: number, peakCallsPerMinute: number, withinPerMinute: boolean, withinDay: boolean }}
 */
export function pacing({ sites, concurrency = PREWARM_CONCURRENCY, runGapMs = DEFAULT_RUN_GAP_MS, secondsPerRun = SECONDS_PER_RUN }) {
  const runsPerDay = sites * RUNS_PER_SITE;
  // A site's two devices run side by side; each device's second run waits the gap after the first.
  const secondsPerSite = RUNS_PER_DEVICE * secondsPerRun + (RUNS_PER_DEVICE - 1) * (runGapMs / 1000);
  const hours = (sites * secondsPerSite) / Math.max(1, concurrency) / 3600;
  // Every site in flight has both devices calling at once, each call lasting secondsPerRun.
  const peakCallsPerMinute = Math.ceil(concurrency * 2 * (60 / secondsPerRun));
  return {
    runsPerDay,
    shareOfDailyCap: runsPerDay / PSI_DAILY_CAP,
    secondsPerSite,
    hours,
    peakCallsPerMinute,
    withinPerMinute: peakCallsPerMinute <= PSI_PER_MINUTE_CAP,
    withinDay: runsPerDay <= PSI_DAILY_CAP,
  };
}

/** Runs a day, steady state, for a library of this size: every site measured again every REMEASURE_DAYS. */
export function steadyRunsPerDay(sites) {
  return Math.ceil(sites / REMEASURE_DAYS) * RUNS_PER_SITE;
}

/** Days to measure the whole list once at `perDay` sites a day (a backfill after the change). */
export function backfillDays(sites, perDay) {
  return Math.ceil(sites / Math.max(1, perDay));
}

/** A call refused for a per-minute limit is tried again after each of these waits (ms), then given up on: at most this many retries. */
export const RATE_LIMIT_WAITS_MS = [15_000, 30_000, 60_000];
/** A device whose last result was a failure is measured again by the daily job only after this long, so a site that keeps failing costs at most one try (two runs) a device a day even if the job runs twice. */
export const FAILED_RETRY_MS = 20 * 60 * 60 * 1000;
