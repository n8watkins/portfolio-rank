import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { REVIEW_ACTIONS, review } from "@/lib/content/blog.mjs";

// The owner's review of one post (docs/CONTENT-ENGINE.md, "Review and
// publish"): publish or reject a draft, or unpublish a published post.
// Only the admin, from this site, with a JSON body (CSRF; lib/admin.ts).
//   POST /api/admin/content/<id>  { "action": "publish" | "reject" | "unpublish", "note"?: string }
// Publishing keeps the weekly cap (2 posts in any 7 days) in the same write;
// a draft whose scheduled time is still ahead is published for that time.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };
const STATUS: Record<string, number> = { not_found: 404, wrong_status: 409, weekly_cap: 409, bad_action: 400 };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireAdminPost(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  const { id } = await params;
  if (!/^[0-9a-f]{16}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: PRIVATE });
  const body = (await req.json().catch(() => null)) as { action?: unknown; note?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!(action in REVIEW_ACTIONS)) return NextResponse.json({ error: "bad_action" }, { status: 400, headers: PRIVATE });
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;
  await ensureSchema();
  const result = await review(db(), id, { action, by: who.login, note, now: new Date() });
  if (!result.ok) return NextResponse.json(result, { status: STATUS[result.error] ?? 400, headers: PRIVATE });
  return NextResponse.json(result, { headers: PRIVATE });
}
