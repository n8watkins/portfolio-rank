import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { PRIVATE, graderEnabled } from "@/lib/grader/server";
import { startGrade } from "@/lib/grader/start";
import { gate, remember, reserve } from "@/lib/tools/server";
import { runAllChecks } from "@/lib/tools/run";
import { profilePath } from "@/lib/profile";

// "Add your portfolio" (/add): one address, every check at once, then the
// portfolio's profile (docs/TOOLS.md "Add your portfolio").
//
// POST /api/add { url, turnstileToken }
//   200 { url, listed, path, checks: { quick, share, speed }, grade: { status, id?, message? } }
//       path is the profile (/p/<address>), which exists from now on;
//       grade is what "grade my portfolio" said: started ("capturing"),
//       waiting for tomorrow's share, or why not (cooldown, cap), with the
//       grader's own rules and caps (lib/grader/start.ts)
//   400 bad_request | <address error> { message }
//   403 bad_origin | turnstile_failed
//   404 not_found (TOOLS_ENABLED is off)
//   422 unreachable { message }: the page can't be loaded; nothing is saved or added
//   429 rate_limited | daily_limit { scope, resetAt }
//
// Lighthouse runs while the visitor waits (about a minute): Workers can't
// finish it in the background after answering. Past the day's speed checks
// it is skipped and the profile says so.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await gate(req, "add");
  if (g instanceof Response) return g;
  await ensureSchema();
  const refused = await reserve(g, "page");
  if (refused) return refused;

  const run = await runAllChecks({ url: g.url, siteKey: g.siteKey }, g);
  if (!run.quick.ok && !run.share.ok) {
    return NextResponse.json({ error: "unreachable", message: run.quick.message ?? "We couldn't load that page." }, { status: 422, headers: PRIVATE });
  }
  await remember(g, true);

  let grade: { status: string; id?: string; message?: string } = { status: "off" };
  if (graderEnabled()) {
    const res = await startGrade(db(), { who: g, target: { url: g.url, siteKey: g.siteKey } });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: string; message?: string; report?: string };
    grade = res.status === 202 ? { status: body.status ?? "capturing", id: body.id } : { status: body.error ?? "not_started", ...(body.report ? { id: body.report } : {}), ...(body.message ? { message: body.message } : {}) };
  }

  return NextResponse.json(
    {
      url: g.url,
      listed: Boolean(g.listed),
      path: profilePath(g.listed ?? g.url),
      checks: { quick: run.quick.ok, share: run.share.ok, speed: run.speedSkipped ? "skipped" : Boolean(run.mobile?.ok || run.desktop?.ok) },
      grade,
    },
    { headers: PRIVATE }
  );
}
