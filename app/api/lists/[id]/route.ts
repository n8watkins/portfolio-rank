import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";
import { sameOrigin } from "@/lib/polls/server";
import { purgeDeletedLists } from "@/lib/list-trash";

const MAX_NAME_LEN = 60;

/**
 * PATCH /api/lists/[id] { name?, isPublic? } → rename and/or toggle visibility.
 * Only the owner can touch a list; a non-matching id/owner is a 404.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);

  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > MAX_NAME_LEN) {
      return NextResponse.json({ error: "bad_name" }, { status: 400 });
    }
    sets.push("name = ?");
    args.push(name);
  }
  if (typeof body?.isPublic === "boolean") {
    sets.push("is_public = ?");
    args.push(body.isPublic ? 1 : 0);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  const res = await db().execute({
    sql: `UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND owner = ? AND deleted_at IS NULL`,
    args: [...args, id, rater.id],
  });
  if (res.rowsAffected === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/lists/[id] → soft-delete the list (owner only). It stays restorable from the
 * Undo toast for a short window; see lib/list-trash.ts and ./trash/route.ts.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  await purgeDeletedLists(rater.id);
  const res = await db().execute({
    sql: "UPDATE lists SET deleted_at = datetime('now') WHERE id = ? AND owner = ? AND deleted_at IS NULL",
    args: [id, rater.id],
  });
  if (res.rowsAffected === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
