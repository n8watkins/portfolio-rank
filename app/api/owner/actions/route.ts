import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/polls/server";
import { isKnownPortfolio } from "@/lib/roster";
import { ownerAction } from "@/lib/games/claims.mjs";
import { PRIVATE, fail, forgetPool, gamesEnabled, off, overLimit, rateLimited } from "@/lib/games/server";
import { accountTooNew, guardConfig } from "@/lib/rater";

// What a verified owner can do with their portfolio (remove and hide always; regrade with GAMES_V2).
// A held removal takes effect hourly (worker/owner-removals.ts), which also clears the quiz pool's cache.
// POST /api/owner/actions { url, action, confirm? }
//   remove         (needs confirm: true, and the meta tag or a reviewed
//                  claim) held for 24 hours with an alert to the site's
//                  owner, then hidden from the site, then moved to
//                  data/excluded.json as an owner request by the weekly
//                  exclusions pull request; /removed counts it without details
//   cancel_remove  withdraws a removal that is still held
//   hide_grade     the AI grade is no longer shown; show_grade shows it again
//   regrade        asks the grade service for a new grade (its cooldown
//                  applies; one open request per site)
//   200 { state: { hideGrade, removedAt, removeAfter }, regrade? }
//   400 bad_request | bad_action | confirm_required, 401 signin_required,
//   403 bad_origin | not_owner | account_too_new | remove_needs_meta | hide_needs_meta,
//   429 rate_limited
// Every action is written to the claims audit log.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

export async function POST(req: Request) {
  // Remove and hide are always on, so removal is self-serve; a re-grade waits for the games (GAMES_V2).
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const s = await auth();
  if (!s?.raterId?.startsWith("gh:")) return fail("signin_required", 401);
  // A GitHub account younger than MIN_GITHUB_ACCOUNT_AGE_DAYS can't act as an
  // owner (lib/rater.ts): throwaway accounts are what a stranger would use.
  if (accountTooNew({ type: "human", accountCreatedAt: s.accountCreatedAt })) {
    return NextResponse.json({ error: "account_too_new", minAccountAgeDays: guardConfig().minAccountAgeDays }, { status: 403, headers: PRIVATE });
  }
  let body: { url?: unknown; action?: unknown; confirm?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const url = typeof body?.url === "string" ? body.url : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!url || !action) return fail("bad_request", 400);
  if (!isKnownPortfolio(url)) return fail("not_owner", 403);
  if (action === "regrade" && !gamesEnabled()) return off();
  if (action === "remove" && body.confirm !== true) return fail("confirm_required", 400);
  await ensureSchema();
  const over = await overLimit([{ key: `owner-action:${s.raterId}`, limit: 20, windowMs: HOUR }]);
  if (over) return rateLimited(over);
  const out = await ownerAction(db(), { url, owner: s.raterId, action, now: new Date() });
  if (!out.ok) return fail(out.error ?? "bad_request", out.error === "not_owner" || out.error === "remove_needs_meta" || out.error === "hide_needs_meta" ? 403 : 400);
  if (action === "hide_grade" || action === "show_grade") {
    // The quiz pool leaves out removed sites and hidden grades.
    await db().execute({ sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] });
    forgetPool();
  }
  return NextResponse.json({ state: out.state, ...(out.regrade ? { regrade: out.regrade } : {}) }, { headers: PRIVATE });
}
