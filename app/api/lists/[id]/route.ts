import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";

export const runtime = "nodejs";

const MAX_NAME_LEN = 60;

/**
 * PATCH /api/lists/[id] { name?, isPublic? } → rename and/or toggle visibility.
 * Only the owner can touch a list; a non-matching id/owner is a 404.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
    sql: `UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND owner = ?`,
    args: [...args, id, rater.id],
  });
  if (res.rowsAffected === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** DELETE /api/lists/[id] → remove the list and its membership rows (owner only). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  const tx = await db().transaction("write");
  try {
    const del = await tx.execute({
      sql: "DELETE FROM lists WHERE id = ? AND owner = ?",
      args: [id, rater.id],
    });
    if (del.rowsAffected === 0) {
      await tx.rollback();
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Membership rows aren't FK-cascaded (libSQL FKs are off by default), so
    // clear them in the same transaction to avoid orphans.
    await tx.execute({
      sql: "DELETE FROM list_items WHERE list_id = ?",
      args: [id],
    });
    await tx.commit();
    return NextResponse.json({ ok: true });
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}
