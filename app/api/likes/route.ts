import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { isKnownPortfolio } from "@/lib/roster";
import { getRater } from "@/lib/rater";

export const runtime = "nodejs";

/**
 * GET /api/likes            → { liked: string[] } — all urls the rater likes
 * GET /api/likes?urls=a,b,c → { liked: string[] } — the subset of those liked
 *
 * Anon raters can't like, so they always get an empty set (the ♥ stays hollow
 * and tapping it opens the sign-in modal).
 */
export async function GET(req: Request) {
  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") return NextResponse.json({ liked: [] });

  const urlsParam = new URL(req.url).searchParams.get("urls");
  if (urlsParam) {
    const urls = urlsParam.split(",").filter(Boolean).slice(0, 200);
    if (urls.length === 0) return NextResponse.json({ liked: [] });
    const placeholders = urls.map(() => "?").join(",");
    const res = await db().execute({
      sql: `SELECT url FROM likes WHERE rater_id = ? AND url IN (${placeholders})`,
      args: [rater.id, ...urls],
    });
    return NextResponse.json({ liked: res.rows.map((r) => String(r.url)) });
  }

  const res = await db().execute({
    sql: "SELECT url FROM likes WHERE rater_id = ? ORDER BY created_at DESC",
    args: [rater.id],
  });
  return NextResponse.json({ liked: res.rows.map((r) => String(r.url)) });
}

/**
 * POST /api/likes { url, want? }
 *   want === true  → like, want === false → unlike, omitted → toggle.
 * Returns { liked, count }. Sign-in required (403 signin_required for anon, the
 * same gate voting uses). Only roster urls are accepted (403 unknown_url).
 */
export async function POST(req: Request) {
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

  const want = typeof body?.want === "boolean" ? body.want : null;

  // libSQL serializes write transactions, so the read-then-write toggle can't
  // race itself into a duplicate/lost like.
  const tx = await db().transaction("write");
  try {
    const exists =
      (
        await tx.execute({
          sql: "SELECT 1 FROM likes WHERE rater_id = ? AND url = ?",
          args: [rater.id, url],
        })
      ).rows.length > 0;
    const liked = want === null ? !exists : want;
    if (liked && !exists) {
      await tx.execute({
        sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)",
        args: [rater.id, url],
      });
    } else if (!liked && exists) {
      await tx.execute({
        sql: "DELETE FROM likes WHERE rater_id = ? AND url = ?",
        args: [rater.id, url],
      });
    }
    const count = Number(
      (
        await tx.execute({
          sql: "SELECT COUNT(*) AS n FROM likes WHERE url = ?",
          args: [url],
        })
      ).rows[0].n
    );
    await tx.commit();
    return NextResponse.json({ liked, count });
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}
