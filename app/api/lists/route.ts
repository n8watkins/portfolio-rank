import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";
import { newSlug } from "@/lib/slug";

export const runtime = "nodejs";

const MAX_LISTS_PER_OWNER = 100;
const MAX_NAME_LEN = 60;

type ListRow = {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  count: number;
  contains?: boolean;
};

/**
 * GET /api/lists          → { lists } the rater owns, each with an item count.
 * GET /api/lists?url=<u>   → same, plus `contains` per list (drives the
 *                            "add to list" picker's checkmarks).
 */
export async function GET(req: Request) {
  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") return NextResponse.json({ lists: [] });

  const url = new URL(req.url).searchParams.get("url");
  const res = await db().execute({
    sql: `SELECT l.id, l.name, l.slug, l.is_public,
                 (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS count,
                 EXISTS(SELECT 1 FROM list_items li2 WHERE li2.list_id = l.id AND li2.url = ?) AS contains
          FROM lists l
          WHERE l.owner = ?
          ORDER BY l.created_at DESC`,
    args: [url ?? "", rater.id],
  });
  const lists: ListRow[] = res.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    slug: String(r.slug),
    isPublic: Number(r.is_public) === 1,
    count: Number(r.count),
    ...(url ? { contains: Number(r.contains) === 1 } : {}),
  }));
  return NextResponse.json({ lists });
}

/** POST /api/lists { name } → create a named list, return it (with a fresh slug). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: "bad_name" }, { status: 400 });
  }

  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 403 });
  }

  const existing = Number(
    (
      await db().execute({
        sql: "SELECT COUNT(*) AS n FROM lists WHERE owner = ?",
        args: [rater.id],
      })
    ).rows[0].n
  );
  if (existing >= MAX_LISTS_PER_OWNER) {
    return NextResponse.json({ error: "too_many_lists" }, { status: 429 });
  }

  // Retry on the (astronomically rare) slug collision the UNIQUE index rejects.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newSlug();
    try {
      const res = await db().execute({
        sql: "INSERT INTO lists (owner, name, slug) VALUES (?, ?, ?) RETURNING id, is_public",
        args: [rater.id, name, slug],
      });
      const row = res.rows[0];
      return NextResponse.json({
        id: Number(row.id),
        name,
        slug,
        isPublic: Number(row.is_public) === 1,
        count: 0,
      });
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) {
        continue;
      }
      throw e;
    }
  }
  return NextResponse.json({ error: "slug_collision" }, { status: 500 });
}
