import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { runPsi, type PsiResult } from "@/lib/tools/psi";
import { isHidden, isKnownPortfolio } from "@/lib/roster";

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
  // A result stays fresh for 30 days; a failure (quota, timeout, a site that
  // won't load) for an hour, so a broken site can't burn the quota by being
  // asked again and again, and a good result is never replaced by a failure.
  // A miss takes the lease first: one PageSpeed run per site at a time, the
  // other callers hear "in_progress" and retry. A stale result is served at
  // once and refreshed in the background (lib/cache.ts).
  const data = await cached<PsiResult>(
    "psi",
    url,
    {
      ttlMs: 30 * 24 * 3600 * 1000,
      isFailure: (d) => !d.ok,
      failureTtlMs: 3600 * 1000,
      leaseOnMiss: { busy: () => ({ ok: false, error: "in_progress" }) },
    },
    () => runPsi(url, "mobile")
  );
  return NextResponse.json(data);
}
