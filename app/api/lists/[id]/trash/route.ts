import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";
import { purgeDeletedLists, restoreDeletedList } from "@/lib/list-trash";

/**
 * POST /api/lists/[id]/trash { action } → the two endings of a "List deleted · Undo" toast:
 * "restore" brings the soft-deleted list back (410 once it is gone), "finalize" removes it
 * for good after the toast closed. Owner only.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (action !== "restore" && action !== "finalize") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  if (action === "finalize") {
    await purgeDeletedLists(rater.id, id);
    return NextResponse.json({ ok: true });
  }
  if (!(await restoreDeletedList(rater.id, id))) {
    return NextResponse.json({ error: "gone" }, { status: 410 });
  }
  return NextResponse.json({ ok: true });
}
