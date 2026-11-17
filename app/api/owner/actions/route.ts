import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/polls/server";
import { isKnownPortfolio } from "@/lib/roster";
import { PROOF_ERRORS, controlProof, ownerAction } from "@/lib/games/claims.mjs";
import { clearPoolCache } from "@/lib/games/pool.mjs";
import { toolsEnabled } from "@/lib/tools/server";
import { loadProfile } from "@/lib/profile";
import { purgeProfile } from "@/lib/edge-purge";
import { PRIVATE, fail, forgetPool, gamesEnabled, off, overLimit, rateLimited } from "@/lib/games/server";
import { accountTooNew, guardConfig } from "@/lib/rater";

// What a verified owner can do with their portfolio (remove and hide always; regrade with GAMES_V2).
// A held removal takes effect hourly (worker/owner-removals.ts), clearing the quiz pool's cache with it.
// POST /api/owner/actions { url, action, confirm? }
//   remove         (needs confirm: true, and the meta tag or a reviewed
//                  claim) held for 24 hours with an alert to the site's
//                  owner, then hidden from the site, then moved to
//                  data/excluded.json as an owner request by the weekly
//                  exclusions pull request; /removed counts it without details
//   cancel_remove  withdraws a removal that is still held; needs the same
//                  proof as remove (a link from the page is not enough), from
//                  any account that has it; logged, and sends no alert by itself
//   hide_grade     the AI grade is no longer shown; show_grade shows it again
//                  (the same proof as remove)
//   regrade        asks the grade service for a new grade (its cooldown
//                  applies; one open request per site)
//   200 { state: { hideGrade, removedAt, removeAfter }, regrade? }
//   400 bad_request | bad_action | confirm_required, 401 signin_required,
//   403 bad_origin | not_owner | account_too_new | remove_needs_meta | cancel_needs_meta | hide_needs_meta,
//   429 rate_limited
// Every action is written to the claims audit log.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;
/** ownerAction's refusals that mean "not with this proof" (403), not a bad request. */
const FORBIDDEN = new Set<string>(PROOF_ERRORS);

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
  // With "Add your portfolio" on, a site added through /add has an owner too.
  const tools = toolsEnabled();
  if (!isKnownPortfolio(url) && !(tools && (await loadProfile(url)))) return fail("not_owner", 403);
  if (action === "regrade" && !gamesEnabled()) return off();
  if (action === "remove" && body.confirm !== true) return fail("confirm_required", 400);
  await ensureSchema();
  // With it on, a re-grade too needs proof only the site's owner can give
  // (the verification file, the meta tag, GitHub Pages or a review;
  // lib/ownership/verify.mjs), not a link from the page to a GitHub profile.
  // Hiding, removing and cancelling a removal always do (ownerAction: hide_needs_meta, remove_needs_meta, cancel_needs_meta).
  if (tools && action === "regrade" && !(await controlProof(db(), { url, owner: s.raterId }))) return fail("not_owner", 403);
  const over = await overLimit([{ key: `owner-action:${s.raterId}`, limit: 20, windowMs: HOUR }]);
  if (over) return rateLimited(over);
  const out = await ownerAction(db(), { url, owner: s.raterId, action, now: new Date() });
  if (!out.ok) return fail(out.error ?? "bad_request", FORBIDDEN.has(String(out.error)) ? 403 : 400);
  // Its profile shows the change at once (worker/edge-cache.ts keeps profiles a day).
  await purgeProfile(url);
  if (action === "hide_grade" || action === "show_grade") {
    // The quiz pool leaves out removed sites and hidden grades.
    await clearPoolCache(db());
    forgetPool();
  }
  return NextResponse.json({ state: out.state, ...(out.regrade ? { regrade: out.regrade } : {}) }, { headers: PRIVATE });
}
