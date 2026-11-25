import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { measureSite, type PsiResult } from "@/lib/tools/psi";
import { psiKey } from "@/lib/tools/keys";
import { store } from "@/lib/tools/server";
import { needsMoreRuns } from "@/lib/psi-runs.mjs";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { CHECK_KINDS } from "@/lib/freshness.mjs";

// Lighthouse for a listed portfolio's profile, from lib/tools/psi.ts, which
// the free speed check (app/api/tools/speed) shares: a check there saves
// under the same "psi:<url>" key, so it refreshes this too. A measure is two
// runs on a phone and two on desktop, averaged per device (lib/psi-runs.mjs).
// The answer and "psi:<url>" are the phone average (what the profile always
// read, with the run details beside it); the desktop average is saved under
// "psi-desktop:<url>", where the scores and the profile read it. A row with
// fewer than two runs attempted (stored before this, or by the speed check)
// is measured again on the next view.
// ?wait=1 (the daily prewarm): a due result is measured before answering.
export type { PsiResult };

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const url = params.get("url");
  const wait = params.get("wait") === "1";
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
  // re-run"): a result is reused until the admin pressed "Re-measure" or it
  // is 90 days old. A failure (quota, timeout, a site that won't load)
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
      upgrade: needsMoreRuns,
      awaitRefresh: wait,
    },
    async () => {
      const { mobile, desktop } = await measureSite(url);
      // Only a good desktop result is saved: a failure never replaces what a profile shows.
      if (desktop.ok) await store(psiKey("desktop", url), desktop);
      return mobile;
    }
  );
  return NextResponse.json(data);
}
