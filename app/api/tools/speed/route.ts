import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { PRIVATE } from "@/lib/grader/server";
import { runPsi, type PsiResult, type Strategy } from "@/lib/tools/psi";
import { gate, readFresh, reserve, store } from "@/lib/tools/server";
import { addPending } from "@/lib/discovery/sites.mjs";

// The free speed check (/tools/speed): Lighthouse on mobile and desktop
// through Google PageSpeed, for any public address (docs/TOOLS.md).
//
// POST /api/tools/speed { url, turnstileToken, addToList? }
//   200 { url, listed, profile?, mobile, desktop, discovery? }
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
// result younger than a day is reused for anyone and costs nothing; a fresh
// run takes one speed check (two PageSpeed runs) of the daily caps
// (lib/tools/caps.mjs). An unlisted site that loads is added to the
// discovery seen-set as pending unless the visitor turned addToList off.
export const dynamic = "force-dynamic";

const key = (strategy: Strategy, url: string) => (strategy === "mobile" ? `psi:${url}` : `psi-desktop:${url}`);

export async function POST(req: Request) {
  const g = await gate(req, "tools");
  if (g instanceof Response) return g;
  await ensureSchema();

  const [freshMobile, freshDesktop] = await Promise.all([readFresh<PsiResult>(key("mobile", g.url)), readFresh<PsiResult>(key("desktop", g.url))]);
  let mobile: PsiResult | null = freshMobile?.ok ? freshMobile : null;
  let desktop: PsiResult | null = freshDesktop?.ok ? freshDesktop : null;

  if (!mobile || !desktop) {
    const refused = await reserve(g, "speed");
    if (refused) return refused;
    const at = Date.now();
    const [m, d] = await Promise.all([mobile ? null : runPsi(g.url, "mobile"), desktop ? null : runPsi(g.url, "desktop")]);
    // Only a good result is saved: a failure never replaces what a profile shows.
    const saves: Promise<void>[] = [];
    if (m?.ok) saves.push(store(key("mobile", g.url), m, at));
    if (d?.ok) saves.push(store(key("desktop", g.url), d, at));
    await Promise.all(saves);
    const measuredAt = new Date(at).toISOString();
    mobile = mobile ?? (m!.ok ? { ...m!, measuredAt } : m!);
    desktop = desktop ?? (d!.ok ? { ...d!, measuredAt } : d!);
  }

  let discovery: { status: string; added: boolean } | null = null;
  if (!g.listed && g.body.addToList !== false && (mobile.ok || desktop.ok)) {
    discovery = await addPending(db(), { url: g.url, source: "tools" });
  }

  return NextResponse.json(
    {
      url: g.url,
      listed: Boolean(g.listed),
      ...(g.listed ? { profile: `/p/${encodeURIComponent(g.listed)}` } : {}),
      mobile,
      desktop,
      discovery,
    },
    { headers: PRIVATE }
  );
}
