import { NextResponse } from "next/server";
import { cached, type CacheMeta } from "@/lib/cache";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { CHECK_KINDS } from "@/lib/freshness.mjs";

// Adapted from site-forge's checkup route. Works keyless at low volume;
// set PSI_API_KEY (free, no billing) for the 25k/day quota.
export type PsiResult = CacheMeta & {
  ok: boolean;
  error?: string;
  scores?: Record<string, number | null>; // 0-100
  metrics?: { id: string; label: string; value: string }[];
};

const METRIC_AUDITS = [
  "largest-contentful-paint",
  "cumulative-layout-shift",
  "total-blocking-time",
] as const;

// The slice of the PageSpeed Insights v5 response this reads.
type PsiResponse = {
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null } | undefined>;
    audits?: Record<string, { title?: string; displayValue?: string } | undefined>;
  };
};

async function runPsi(target: string): Promise<PsiResult> {
  // PSI_API_BASE points the end-to-end tests at a local stand-in for Google.
  const psiUrl = new URL(
    process.env.PSI_API_BASE ??
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
  );
  psiUrl.searchParams.set("url", target);
  psiUrl.searchParams.set("strategy", "mobile");
  if (process.env.PSI_API_KEY) {
    psiUrl.searchParams.set("key", process.env.PSI_API_KEY);
  }
  for (const cat of ["performance", "accessibility", "best-practices", "seo"]) {
    psiUrl.searchParams.append("category", cat);
  }

  let data: PsiResponse;
  try {
    const res = await fetch(psiUrl.toString(), {
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: err?.error?.message ?? `psi_${res.status}`,
      };
    }
    data = await res.json();
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "TimeoutError" ? "timeout" : "fetch_error" };
  }

  const lhr = data.lighthouseResult;
  if (!lhr) return { ok: false, error: "no_data" };

  const scores: Record<string, number | null> = {};
  for (const id of ["performance", "accessibility", "best-practices", "seo"]) {
    const raw = lhr.categories?.[id]?.score;
    scores[id] = typeof raw === "number" ? Math.round(raw * 100) : null;
  }

  const metrics = METRIC_AUDITS.flatMap((id) => {
    const audit = lhr.audits?.[id];
    return audit?.displayValue
      ? [{ id, label: audit.title ?? id, value: audit.displayValue }]
      : [];
  });

  return { ok: true, scores, metrics };
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  // Only audit sites on the roster - keeps strangers from burning the PSI
  // quota or pointing our server at arbitrary URLs.
  if (!url || !isKnownPortfolio(url)) {
    return NextResponse.json({ ok: false, error: "unknown_url" }, { status: 403 });
  }
  // A site the health check found down, dead or parked has nothing to
  // measure: don't spend PageSpeed quota on it.
  if (await isHidden(url)) {
    return NextResponse.json({ ok: false, error: "site_down" } satisfies PsiResult);
  }
  // When Lighthouse runs again (lib/freshness.mjs, AUTOMATION.md "When checks
  // re-run"): a result is reused while the site is unchanged, and measured
  // again when its change fingerprint moved, the admin pressed "Re-measure",
  // or it is 90 days old. A failure (quota, timeout, a site that won't load)
  // is retried after an hour, so a broken site can't burn the quota by being
  // asked again and again, and a good result is never replaced by a failure.
  // A miss takes the lease first: one PageSpeed run per site at a time, the
  // other callers hear "in_progress" and retry. A due result is served at
  // once and refreshed in the background (lib/cache.ts).
  const data = await cached<PsiResult>(
    "psi",
    url,
    {
      ttlMs: CHECK_KINDS.lighthouse.maxAgeMs,
      isFailure: (d) => !d.ok,
      failureTtlMs: CHECK_KINDS.lighthouse.failureRetryMs,
      leaseOnMiss: { busy: () => ({ ok: false, error: "in_progress" }) },
      freshness: { kind: "lighthouse", url },
    },
    () => runPsi(url)
  );
  return NextResponse.json(data);
}
