import { NextResponse } from "next/server";
import { peekCached } from "@/lib/cache";
import type { PsiResult } from "@/lib/tools/psi";
import { isHidden, isKnownPortfolio } from "@/lib/roster";

// Lighthouse for a listed portfolio's profile: a pure read. GET
// /api/psi?url=<listed site> returns what is stored under "psi:<url>" (the
// phone result: the average of two runs, or one run for a row stored before
// two runs a device or by a visitor's speed check; the run details are in the
// result, lib/psi-runs.mjs), or { ok: false, error: "not_measured" } when
// nothing is. It never starts PageSpeed, never takes a lease and never makes
// the visitor wait. The measuring is the daily prewarm job's
// (scripts/prewarm-metrics.mjs): it calls PageSpeed from its own runner and
// writes the results, desktop ones to "psi-desktop:<url>".
export type { PsiResult };

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  // Only listed sites: nobody can use this to look at arbitrary addresses.
  if (!url || !isKnownPortfolio(url)) {
    return NextResponse.json({ ok: false, error: "unknown_url" }, { status: 403 });
  }
  // A site the health check found down, dead or parked has nothing to show.
  if (await isHidden(url)) {
    return NextResponse.json({ ok: false, error: "site_down" } satisfies PsiResult);
  }
  const stored = await peekCached<PsiResult>("psi", url);
  return NextResponse.json(stored ?? ({ ok: false, error: "not_measured" } satisfies PsiResult), { headers: NO_STORE });
}
