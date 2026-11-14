import { NextResponse } from "next/server";
import { browserCache, cached, peekCached } from "@/lib/cache";
import { runPsi, type PsiResult, type Strategy } from "@/lib/tools/psi";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { CHECK_KINDS } from "@/lib/freshness.mjs";

// Lighthouse for a listed portfolio's profile (mobile), from lib/tools/psi.ts,
// which the free speed check (app/api/tools/speed) shares: a check there
// saves under the same "psi:<url>" key, so it refreshes this too.
export type { PsiResult };

// The maximum age of a result (lib/freshness.mjs; mobile and desktop alike).
const PSI_TTL_MS = CHECK_KINDS.lighthouse.maxAgeMs;

/**
 * PageSpeed strategies: mobile (the default, cached as psi:<url>, as before)
 * and desktop (the games show both; cached as psi-desktop:<url>, with the
 * same TTLs and lease).
 */
const NAMESPACE: Record<Strategy, string> = { mobile: "psi", desktop: "psi-desktop" };

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const url = params.get("url");
  const strategy: Strategy = params.get("strategy") === "desktop" ? "desktop" : "mobile";
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
  // ?cached=1: only a result already stored, never a PageSpeed run
  // ("not_measured" otherwise); Play reads it first and measures on a miss.
  // It says whether the result is due by the same rule, without a refresh.
  if (params.get("cached") === "1") {
    const hit = await peekCached<PsiResult>(NAMESPACE[strategy], url, PSI_TTL_MS, { isFailure: (d) => !d.ok, freshness: { kind: "lighthouse", url } });
    const body = hit ?? ({ ok: false, error: "not_measured" } satisfies PsiResult);
    return NextResponse.json(body, { headers: { "cache-control": browserCache(body) } });
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
    NAMESPACE[strategy],
    url,
    {
      ttlMs: PSI_TTL_MS,
      isFailure: (d) => !d.ok,
      failureTtlMs: CHECK_KINDS.lighthouse.failureRetryMs,
      leaseOnMiss: { busy: () => ({ ok: false, error: "in_progress" }) },
      freshness: { kind: "lighthouse", url },
    },
    () => runPsi(url, strategy)
  );
  return NextResponse.json(data, { headers: { "cache-control": browserCache(data) } });
}
