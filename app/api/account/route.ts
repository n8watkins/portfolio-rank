import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { accountData, deleteAccount, gradeShotKeys } from "@/lib/account.mjs";
import { sameOrigin } from "@/lib/polls/server";
import { getRater } from "@/lib/rater";
import { revokeSessions } from "@/lib/session-revocation.mjs";
// The grader's keyed requester id: grade requests made while signed in are the account's too.
import { deleteGradeShots, keyed } from "@/lib/grader/server";

// The signed-in account's own data (lib/account.mjs), self-serve from /settings.
// GET    /api/account -> a JSON file of everything held about the account
// DELETE /api/account { confirm: "<GitHub username or the email address>" } -> { deleted: { table: rows } }
//        deletes it all in one transaction; the page then signs out
//   401 signin_required, 403 bad_origin, 400 confirm_mismatch
export const dynamic = "force-dynamic";
const PRIVATE = { "cache-control": "private, no-store" };

async function human() {
  const rater = await getRater();
  return rater.type === "human" ? rater : null;
}

export async function GET() {
  await ensureSchema();
  const me = await human();
  if (!me) return NextResponse.json({ error: "signin_required" }, { status: 401, headers: PRIVATE });
  const data = await accountData(db(), me.id, { login: me.login, gradeVisitor: keyed("visitor", me.id) });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      ...PRIVATE,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="portfoliorank-${me.id.startsWith("gh:") && me.login ? me.login.replace(/[^A-Za-z0-9-]/g, "") : "account"}.json"`,
    },
  });
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: PRIVATE });
  await ensureSchema();
  const me = await human();
  if (!me) return NextResponse.json({ error: "signin_required" }, { status: 401, headers: PRIVATE });
  let confirm = "";
  try {
    confirm = String((await req.json())?.confirm ?? "").trim().replace(/^@/, "");
  } catch {}
  if (!me.login || confirm.toLowerCase() !== me.login.toLowerCase()) {
    return NextResponse.json({ error: "confirm_mismatch" }, { status: 400, headers: PRIVATE });
  }
  const gradeVisitor = keyed("visitor", me.id);
  const shots = await gradeShotKeys(db(), gradeVisitor);
  const deleted = await deleteAccount(db(), me.id, { gradeVisitor });
  // Every session of the deleted account ends, on every device (lib/session-revocation.mjs).
  await revokeSessions(db(), me.id);
  for (const key of shots) await deleteGradeShots(key);
  return NextResponse.json({ deleted }, { headers: PRIVATE });
}
