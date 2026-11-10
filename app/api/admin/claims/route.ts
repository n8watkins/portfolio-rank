import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { sameOrigin } from "@/lib/polls/server";
import { claimById, reviewQueue, setClaimStatus } from "@/lib/games/claims.mjs";
import { PRIVATE, fail, gamesEnabled, off } from "@/lib/games/server";

// The site owner's review of portfolio claims (GAMES_V2), only for
// ADMIN_GITHUB_LOGIN.
// GET  /api/admin/claims -> { claims } waiting for review, oldest first
// POST /api/admin/claims { id, decision: "verified" | "rejected", note? }
//   -> { claim }; 400 bad_request, 401/403, 404 not_found, 409 not_in_review
// Decisions go to the claims audit log under "admin:<login>".
export const dynamic = "force-dynamic";

const denied = (error: "signin_required" | "forbidden") => fail(error, error === "signin_required" ? 401 : 403);

export async function GET() {
  if (!gamesEnabled()) return off();
  const admin = await requireAdmin();
  if ("error" in admin) return denied(admin.error);
  await ensureSchema();
  return NextResponse.json({ claims: await reviewQueue(db()) }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const admin = await requireAdmin();
  if ("error" in admin) return denied(admin.error);
  let body: { id?: unknown; decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const id = body?.id;
  const decision = body?.decision;
  if (typeof id !== "number" || !Number.isInteger(id) || (decision !== "verified" && decision !== "rejected")) return fail("bad_request", 400);
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  await ensureSchema();
  const claim = await claimById(db(), id);
  if (!claim) return fail("not_found", 404);
  if (claim.status !== "review") return fail("not_in_review", 409);
  const out = await setClaimStatus(db(), { claim, status: decision, method: claim.method ?? "manual", note, actor: `admin:${admin.login}`, now: new Date() });
  return NextResponse.json({ claim: out }, { headers: PRIVATE });
}
