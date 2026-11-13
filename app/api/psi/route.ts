import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { runPsi, type PsiResult } from "@/lib/tools/psi";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { CHECK_KINDS } from "@/lib/freshness.mjs";

// Lighthouse for a listed portfolio's profile (mobile), from lib/tools/psi.ts,
// which the free speed check (app/api/tools/speed) shares: a check there
// saves under the same "psi:<url>" key, so it refreshes this too.
export type { PsiResult };

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
    () => runPsi(url, "mobile")
  );
  return NextResponse.json(data);
}
