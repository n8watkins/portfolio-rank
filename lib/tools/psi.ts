import type { CacheMeta } from "@/lib/cache";
import { fixFor } from "./fixes";

// Google PageSpeed Insights (Lighthouse in Google's cloud), shared by the
// profile's diagnostics (app/api/psi, listed portfolios, mobile) and the
// free speed check (app/api/tools/speed, any address, mobile and desktop).
// PSI_API_KEY is a key in a Google project with no billing account: 25,000
// runs a day, and past that Google refuses instead of charging. Keyless
// calls have a quota of zero today, so without the key every run fails.

export type Strategy = "mobile" | "desktop";

export type PsiMetric = { id: string; label: string; value: string; score?: number | null };
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
};

export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

const METRICS: { id: string; label: string }[] = [
  { id: "largest-contentful-paint", label: "Largest Contentful Paint" },
  { id: "first-contentful-paint", label: "First Contentful Paint" },
  { id: "total-blocking-time", label: "Total Blocking Time" },
  { id: "cumulative-layout-shift", label: "Cumulative Layout Shift" },
  { id: "speed-index", label: "Speed Index" },
];

type Audit = {
  title?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
};

// The slice of the PageSpeed Insights v5 response this reads.
type PsiResponse = {
  lighthouseResult?: {
    finalDisplayedUrl?: string;
    categories?: Record<string, { score?: number | null; auditRefs?: { id: string; weight?: number; group?: string }[] } | undefined>;
    audits?: Record<string, Audit | undefined>;
  };
};

const MAX_FIXES = 6;

/** The failing audits of a Lighthouse result that have a plain-words fix, biggest win first. */
export function pickFixes(lhr: NonNullable<PsiResponse["lighthouseResult"]>): PsiFix[] {
  const out: (PsiFix & { rank: number })[] = [];
  const seen = new Set<string>();
  for (const category of CATEGORIES) {
    for (const ref of lhr.categories?.[category]?.auditRefs ?? []) {
      if (seen.has(ref.id) || ref.group === "metrics" || ref.group === "hidden") continue;
      const a = lhr.audits?.[ref.id];
      if (!a || typeof a.score !== "number" || a.score >= 0.9) continue;
      if (a.scoreDisplayMode === "notApplicable" || a.scoreDisplayMode === "manual" || a.scoreDisplayMode === "informative") continue;
      const tip = fixFor(ref.id);
      if (!tip) continue;
      seen.add(ref.id);
      const savedMs = Object.values(a.metricSavings ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
      // Speed fixes rank by time saved; the others by the weight Lighthouse gives them, after a fast win.
      const rank = category === "performance" ? savedMs + (1 - a.score) * 100 : (ref.weight ?? 1) * 40;
      out.push({ id: ref.id, title: tip.title ?? a.title ?? ref.id, savings: a.displayValue || undefined, tip: tip.tip, category, rank });
    }
  }
  return out
    .sort((x, y) => y.rank - x.rank)
    .slice(0, MAX_FIXES)
    .map(({ rank, ...f }) => (void rank, f));
}

/** Turns a PageSpeed response into the stored result. */
export function readPsi(data: PsiResponse, strategy: Strategy): PsiResult {
  const lhr = data.lighthouseResult;
  if (!lhr) return { ok: false, error: "no_data", strategy };
  const scores: Record<string, number | null> = {};
  for (const id of CATEGORIES) {
    const raw = lhr.categories?.[id]?.score;
    scores[id] = typeof raw === "number" ? Math.round(raw * 100) : null;
  }
  const metrics = METRICS.flatMap(({ id, label }) => {
    const a = lhr.audits?.[id];
    return a?.displayValue ? [{ id, label, value: a.displayValue.replace(/ /g, " "), score: typeof a.score === "number" ? a.score : null }] : [];
  });
  return { ok: true, strategy, scores, metrics, fixes: pickFixes(lhr), ...(lhr.finalDisplayedUrl ? { finalUrl: lhr.finalDisplayedUrl } : {}) };
}

/** One PageSpeed run. Never throws: a quota, timeout or site error is { ok: false, error }. */
export async function runPsi(target: string, strategy: Strategy = "mobile"): Promise<PsiResult> {
  // PSI_API_BASE points the end-to-end tests at a local stand-in for Google.
  const psiUrl = new URL(process.env.PSI_API_BASE ?? "https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  psiUrl.searchParams.set("url", target);
  psiUrl.searchParams.set("strategy", strategy);
  if (process.env.PSI_API_KEY) psiUrl.searchParams.set("key", process.env.PSI_API_KEY);
  for (const cat of CATEGORIES) psiUrl.searchParams.append("category", cat);

  let data: PsiResponse;
  try {
    const res = await fetch(psiUrl.toString(), { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      // 429 is the day's quota; 400/500 usually mean Lighthouse couldn't load the page.
      const error = res.status === 429 ? "quota" : res.status >= 500 || res.status === 400 ? "unreachable" : `psi_${res.status}`;
      console.log(JSON.stringify({ event: "psi.error", status: res.status, strategy, message: String(err?.error?.message ?? "").slice(0, 200) }));
      return { ok: false, error, strategy };
    }
    data = (await res.json()) as PsiResponse;
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "TimeoutError" ? "timeout" : "fetch_error", strategy };
  }
  return readPsi(data, strategy);
}
