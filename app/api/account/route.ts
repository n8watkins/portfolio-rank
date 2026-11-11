import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { accountData, deleteAccount } from "@/lib/account.mjs";
import { sameOrigin } from "@/lib/polls/server";
import { getRater } from "@/lib/rater";

// The signed-in account's own data (lib/account.mjs), self-serve from /settings.
// GET    /api/account -> a JSON file of everything held about the account
// DELETE /api/account { confirm: "<GitHub username>" } -> { deleted: { table: rows } }
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
  const data = await accountData(db(), me.id, { login: me.login });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      ...PRIVATE,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="portfoliorank-${me.login ?? "account"}.json"`,
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
  const deleted = await deleteAccount(db(), me.id);
  return NextResponse.json({ deleted }, { headers: PRIVATE });
}
