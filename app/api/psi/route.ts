import { NextResponse } from "next/server";
import { measureNow, peekCached } from "@/lib/cache";
import { measureSite, type PsiResult } from "@/lib/tools/psi";
import { psiKey } from "@/lib/tools/keys";
import { storeIfBetter } from "@/lib/tools/server";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { INTERNAL_TOKEN_HEADER, MEASURE_PSI, internalToken } from "@/lib/internal-token.mjs";

// Lighthouse for a listed portfolio's profile, stored by lib/tools/psi.ts,
// which the free speed check (app/api/tools/speed) shares.
//
// A view never measures. GET /api/psi?url=<listed site> returns what is
// stored: the phone result ("psi:<url>", the average of two runs, or one run
// for a row stored before two runs a device or by a visitor's speed check; the
// run details are in the result, lib/psi-runs.mjs), or { ok: false, error:
// "not_measured" } when nothing is. It never starts PageSpeed and never makes
// the visitor wait: on the deployed Worker, work left running after the
// response is cut off after about 30 seconds, and a measure of four runs takes
// longer than that.
//
// Only the daily prewarm job (scripts/prewarm-metrics.mjs) measures, and it
// waits for the answer. It sends the internal token (lib/internal-token.mjs,
// purpose MEASURE_PSI); without it the same request is a plain view. A measure
// is two runs on a phone and two on desktop, averaged per device: the phone
// average is stored in "psi:<url>" and the answer ({ ..., measured: true }),
// the desktop average in "psi-desktop:<url>", where the scores and the profile
// read it. The answer says { ok: false, error } when nothing new was stored:
// "in_progress" (another measure holds the site), or the failure's reason.
export type { PsiResult };

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

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

  const secret = process.env.AUTH_SECRET;
  const sent = req.headers.get(INTERNAL_TOKEN_HEADER) ?? "";
  const mayMeasure = Boolean(secret) && sent !== "" && sent === (await internalToken(secret, MEASURE_PSI));

  if (!mayMeasure) {
    const stored = await peekCached<PsiResult>("psi", url);
    return NextResponse.json(stored ?? ({ ok: false, error: "not_measured" } satisfies PsiResult), { headers: NO_STORE });
  }

  const { status, data } = await measureNow<PsiResult>("psi", url, { isFailure: (d) => !d.ok }, async () => {
    const { mobile, desktop } = await measureSite(url);
    // The desktop average is stored beside the phone one; a failure never replaces a good result.
    await storeIfBetter(psiKey("desktop", url), desktop);
    return mobile;
  });
  return NextResponse.json(status === "stored" ? { ...data, measured: true } : data, { headers: NO_STORE });
}
