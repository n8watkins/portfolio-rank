import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { PRIVATE, fail, graderEnabled, keyed } from "@/lib/grader/server";
import { startGrade } from "@/lib/grader/start";
import { gate, remember, reserve } from "@/lib/tools/server";
import { runAllChecks } from "@/lib/tools/run";
import { EXISTS_TIMEOUT_MS, siteExists } from "@/lib/tools/exists.mjs";
import { siteHop } from "@/lib/ownership/hop";
import { seen } from "@/lib/discovery/sites.mjs";
import { rateLimit } from "@/lib/polls/store.mjs";
import { profilePath } from "@/lib/profile";

// "Add your portfolio" (/add): one address, every check at once, then the
// portfolio's profile (docs/TOOLS.md "Add your portfolio").
//
// POST /api/add { url, turnstileToken }
//   200 { url, listed, path, already?, checks?, grade? }
//       already "listed" (on the list) or "added" (added before): nothing
//       runs, path is its profile. Otherwise path is the new profile;
//       grade is what "grade my portfolio" said: started ("capturing"),
//       waiting for tomorrow's share, or why not (cooldown, cap), with the
//       grader's own rules and caps (lib/grader/start.ts)
//   400 bad_request | <address error> { message }
//   403 bad_origin | turnstile_failed
//   404 not_found (TOOLS_ENABLED is off)
//   422 unreachable | not_ok | not_html | empty | parked | redirects_away |
//       redirect_loop { message }: the site isn't really there (one GET,
//       lib/tools/exists.mjs); nothing is saved or added
//   429 rate_limited | add_limit | daily_limit { scope, resetAt }
//
// Adding is welcome (owner, 2026-11-13: free data), so the only cap of its
// own is against spam: ADDS_PER_DAY by account, or by address when signed
// out. Grading stays inside the grader's own caps (a few a day per visitor
// and network, a site-wide day and a short waiting line, lib/grader/caps.mjs),
// and nothing here calls Gemini (tests/gemini-reach.test.mjs): however many
// sites are added, the grades wait in the queue for the day's Gemini budget,
// which is zero while Gemini is frozen.
//
// Lighthouse runs while the visitor waits (about a minute): Workers can't
// finish it in the background after answering. Past the day's speed checks
// it is skipped and the profile says so.
export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;
/** Adds a day: per account when signed in, per address when not. */
const ADDS_PER_DAY = { account: 25, ip: 5 };

export async function POST(req: Request) {
  const g = await gate(req, "add");
  if (g instanceof Response) return g;
  await ensureSchema();

  // Already on PortfolioRank: say so, with its profile.
  if (g.listed) return NextResponse.json({ url: g.listed, listed: true, path: profilePath(g.listed), already: "listed" }, { headers: PRIVATE });
  const before = await seen(db(), g.url);
  if (before && before.status !== "dropped") return NextResponse.json({ url: g.url, listed: false, path: profilePath(g.url), already: "added" }, { headers: PRIVATE });

  // Against spam: 25 adds a day per account, 5 per address signed out.
  const signedIn = /^(gh|em):/.test(g.player);
  const limit = signedIn
    ? await rateLimit(db(), `add:a:${keyed("visitor", g.player)}`, { limit: ADDS_PER_DAY.account, windowMs: DAY })
    : await rateLimit(db(), `add:ip:${keyed("ip", g.ip || "none")}`, { limit: ADDS_PER_DAY.ip, windowMs: DAY });
  if (!limit.ok) {
    const message = signedIn ? `That's ${ADDS_PER_DAY.account} sites added today. Try again tomorrow.` : `That's ${ADDS_PER_DAY.ip} sites added today. Sign in to add more.`;
    return fail("add_limit", 429, { message }, { "retry-after": String(limit.retryAfterSec) });
  }

  // Really there: one GET, 200 with HTML that isn't a parked or for-sale page.
  const exists = await siteExists({ url: g.url, hop: siteHop(EXISTS_TIMEOUT_MS) });
  if (!exists.ok) return fail(String(exists.reason), 422, { message: exists.message });

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
      listed: false,
      path: profilePath(g.url),
      checks: { quick: run.quick.ok, share: run.share.ok, speed: run.speedSkipped ? "skipped" : Boolean(run.mobile?.ok || run.desktop?.ok) },
      grade,
    },
    { headers: PRIVATE }
  );
}
