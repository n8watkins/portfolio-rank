import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/polls/server";
import { getRater } from "@/lib/rater";
import { revokeSessions } from "@/lib/session-revocation.mjs";

// "Sign out everywhere" (/settings): every session of the signed-in account,
// on every device, this one too, is signed out the next time it is read
// (lib/session-revocation.mjs). Other devices follow within a minute.
// POST /api/account/sessions -> 200 { ok: true }
//   401 signin_required, 403 bad_origin
export const dynamic = "force-dynamic";
const PRIVATE = { "cache-control": "private, no-store" };

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: PRIVATE });
  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") return NextResponse.json({ error: "signin_required" }, { status: 401, headers: PRIVATE });
  await revokeSessions(db(), rater.id);
  return NextResponse.json({ ok: true }, { headers: PRIVATE });
}
