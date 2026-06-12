import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { isKnownPortfolio } from "@/lib/roster";

export const runtime = "nodejs";

// Adapted from site-forge's checkup route. Works keyless at low volume;
// set PSI_API_KEY (free, no billing) for the 25k/day quota.
export type PsiResult = {
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

async function runPsi(target: string): Promise<PsiResult> {
  const psiUrl = new URL(
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

  let data: any;
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
  } catch (e: any) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "fetch_error" };
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
  // Only audit sites on the roster — keeps strangers from burning the PSI
  // quota or pointing our server at arbitrary URLs.
  if (!url || !isKnownPortfolio(url)) {
    return NextResponse.json({ ok: false, error: "unknown_url" }, { status: 403 });
  }
  // Quota errors and timeouts are transient — never cache failures.
  const data = await cached<PsiResult>(
    "psi",
    url,
    30 * 24 * 3600 * 1000,
    () => runPsi(url),
    (d) => d.ok
  );
  return NextResponse.json(data);
}
