import type { CacheMeta } from "@/lib/cache";
import { runPsiCall } from "../psi-core.mjs";
import { countPsiCall } from "../psi-calls.mjs";
import { db } from "../db";

// Google PageSpeed Insights (Lighthouse in Google's cloud) from the Worker:
// the free speed check (app/api/tools/speed) and "Add" and "Re-check"
// (lib/tools/run.ts) make single runs here, mobile and desktop, for any
// address. How a call is made and its answer read is lib/psi-core.mjs, which
// the daily prewarm job shares (it makes the stored two-run averages, lib/psi-job.mjs);
// a profile only reads what is stored (app/api/psi). PSI_API_KEY is a key in a
// Google project with no billing account: 25,000 runs a day, and past that
// Google refuses instead of charging.

export type Strategy = "mobile" | "desktop";

export type PsiMetric = {
  id: string;
  label: string;
  value: string;
  score?: number | null;
  /** The raw value (milliseconds, or unitless for layout shift): what several runs are averaged from. */
  numeric?: number | null;
};
export type PsiFix = { id: string; title: string; savings?: string; tip: string; category: string };

export type PsiResult = CacheMeta & {
  ok: boolean;
  error?: string;
  strategy?: Strategy;
  scores?: Record<string, number | null>; // 0-100
  metrics?: PsiMetric[];
  /** The failing audits worth fixing first, biggest win first, with a plain tip. */
  fixes?: PsiFix[];
  /** The address Lighthouse ended on after redirects. */
  finalUrl?: string;
  /** Page weight and request count from the same run. */
  weight?: { bytes: number | null; requests: number | null };
  // Run details (lib/psi-runs.mjs). Everything above is the average of the
  // runs that succeeded. A row stored before these existed is one run.
  /** How many runs succeeded and went into the numbers. */
  runs?: number;
  /** How many runs were made (what counted against the PageSpeed quota). */
  runsAttempted?: number;
  /** The performance score of each attempted run, null where that run failed. */
  runScores?: (number | null)[];
  /** When it was measured (ISO 8601). */
  ranAt?: string;
  /** Lighthouse's own time stamp of a single run: two runs with the same one are the same run. */
  fetchedAt?: string;
};

/**
 * One PageSpeed run, counted for the admin limits page. Never throws: a quota,
 * rate limit, timeout or site error is { ok: false, error }, and a counter
 * that cannot be written changes nothing.
 */
export async function runPsi(target: string, strategy: Strategy = "mobile"): Promise<PsiResult> {
  try {
    await countPsiCall(db());
  } catch {
    // Counting must never stop a run.
  }
  return (await runPsiCall(target, strategy)) as PsiResult;
}
