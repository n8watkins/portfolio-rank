import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";
import { isKnownPortfolio } from "@/lib/roster";

export const runtime = "nodejs";

const MAX_ITEMS_PER_LIST = 500;

/** Confirm the list exists and belongs to this rater; returns false otherwise. */
async function ownsList(listId: number, raterId: string): Promise<boolean> {
  const res = await db().execute({
    sql: "SELECT 1 FROM lists WHERE id = ? AND owner = ?",
    args: [listId, raterId],
  });
  return res.rows.length > 0;
}

async function itemCount(listId: number): Promise<number> {
  return Number(
    (
      await db().execute({
        sql: "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?",
        args: [listId],
      })
    ).rows[0].n
  );
}

/** POST /api/lists/[id]/items { url } → add a roster url to the list (idempotent). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const url = body?.url;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isKnownPortfolio(url)) {
    return NextResponse.json({ error: "unknown_url" }, { status: 403 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  // Ownership check + cap check + insert in one write transaction (libSQL
  // serializes these), so concurrent adds can't both slip past MAX_ITEMS, and
  // the returned count is derived rather than re-queried.
  const tx = await db().transaction("write");
  try {
    const owns =
      (
        await tx.execute({
          sql: "SELECT 1 FROM lists WHERE id = ? AND owner = ?",
          args: [id, rater.id],
        })
      ).rows.length > 0;
    if (!owns) {
      await tx.rollback();
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const count = Number(
      (
        await tx.execute({
          sql: "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?",
          args: [id],
        })
      ).rows[0].n
    );
    const present =
      (
        await tx.execute({
          sql: "SELECT 1 FROM list_items WHERE list_id = ? AND url = ?",
          args: [id, url],
        })
      ).rows.length > 0;
    // The cap only blocks genuinely new items — re-adding an existing url is an
    // idempotent no-op and must still succeed even on a full list.
    if (!present && count >= MAX_ITEMS_PER_LIST) {
      await tx.rollback();
      return NextResponse.json({ error: "list_full" }, { status: 429 });
    }
    if (!present) {
      await tx.execute({
        sql: "INSERT INTO list_items (list_id, url) VALUES (?, ?)",
        args: [id, url],
      });
    }
    await tx.commit();
    return NextResponse.json({ ok: true, count: present ? count : count + 1 });
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

/** DELETE /api/lists/[id]/items?url=<u> → remove a url from the list. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const url = new URL(req.url).searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }
  if (!(await ownsList(id, rater.id))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db().execute({
    sql: "DELETE FROM list_items WHERE list_id = ? AND url = ?",
    args: [id, url],
  });
  return NextResponse.json({ ok: true, count: await itemCount(id) });
}
