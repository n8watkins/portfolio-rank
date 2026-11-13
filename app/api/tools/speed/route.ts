import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { PRIVATE } from "@/lib/grader/server";
import { runPsi, type PsiResult } from "@/lib/tools/psi";
import { answerHead, gate, readFresh, remember, reserve, store, wantsFresh } from "@/lib/tools/server";
import { psiKey } from "@/lib/tools/keys";

// The free speed check (/tools/speed): Lighthouse on mobile and desktop
// through Google PageSpeed, for any public address (docs/TOOLS.md).
//
// POST /api/tools/speed { url, turnstileToken, fresh? }
//   200 { url, listed, profile?, mobile, desktop, discovery }
//       mobile and desktop are PsiResult (lib/tools/psi.ts); a failed side
//       says { ok: false, error } and the other still shows
//   400 bad_request | <address error> { message }
//   403 bad_origin | turnstile_failed
//   404 not_found (TOOLS_ENABLED is off)
//   429 rate_limited (Retry-After) | daily_limit { scope, resetAt }
//
// No throwaway results: they are saved under the cache keys the profile
// reads ("psi:<url>" for mobile, "psi-desktop:<url>"), and for a listed
// portfolio under its listed address, so a check refreshes its profile. A
// result younger than a day is reused for anyone and costs nothing, unless
// the visitor asks to measure again (fresh); a run takes one speed check
// (two PageSpeed runs) of the daily caps (lib/tools/caps.mjs). An unlisted
// site that loads joins the discovery seen-set as pending.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gate(req, "tools");
  if (g instanceof Response) return g;
  await ensureSchema();

  const fresh = wantsFresh(g);
  const [freshMobile, freshDesktop] = fresh ? [null, null] : await Promise.all([readFresh<PsiResult>(psiKey("mobile", g.url)), readFresh<PsiResult>(psiKey("desktop", g.url))]);
  let mobile: PsiResult | null = freshMobile?.ok ? freshMobile : null;
  let desktop: PsiResult | null = freshDesktop?.ok ? freshDesktop : null;

  if (!mobile || !desktop) {
    const refused = await reserve(g, "speed");
    if (refused) return refused;
    const at = Date.now();
    const [m, d] = await Promise.all([mobile ? null : runPsi(g.url, "mobile"), desktop ? null : runPsi(g.url, "desktop")]);
    // Only a good result is saved: a failure never replaces what a profile shows.
    const saves: Promise<void>[] = [];
    if (m?.ok) saves.push(store(psiKey("mobile", g.url), m, at));
    if (d?.ok) saves.push(store(psiKey("desktop", g.url), d, at));
    await Promise.all(saves);
    const measuredAt = new Date(at).toISOString();
    mobile = mobile ?? (m!.ok ? { ...m!, measuredAt } : m!);
    desktop = desktop ?? (d!.ok ? { ...d!, measuredAt } : d!);
  }

  const discovery = await remember(g, mobile.ok || desktop.ok);
  return NextResponse.json({ ...answerHead(g), mobile, desktop, discovery }, { headers: PRIVATE });
}
