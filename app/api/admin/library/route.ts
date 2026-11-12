import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { ACTIONS, decide, editImage, librarySummary, listImages } from "@/lib/content/library.mjs";

// The image library's review (docs/CONTENT-ENGINE.md, "The image library"),
// only for the GitHub account in ADMIN_GITHUB_ID; the page is /admin/images.
//   GET  /api/admin/library -> { summary, images }, newest first
//   POST /api/admin/library { id, action: "keep" | "drop" | "retire" }
//   POST /api/admin/library { id, action: "restore", to: "pending" | "rejected-auto" }
//        (the Undo of a drop)
//   POST /api/admin/library { id, action: "edit", alt?, tags? }
//     -> { image }; 400 bad_request (or the cleaning message for alt and
//        tags), 401, 403 (forbidden or bad_origin), 404 not_found,
//        409 wrong_status
// keep and drop apply to pending and rejected-auto images, retire to
// approved ones, restore to dropped ones. Nothing here deletes an image.
// POSTs must come from this site with a JSON body (CSRF).
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: PRIVATE });

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  await ensureSchema();
  const client = db();
  const [summary, images] = await Promise.all([librarySummary(client), listImages(client, { limit: 1000 })]);
  return NextResponse.json({ summary, images }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  let body: { id?: unknown; action?: unknown; to?: unknown; alt?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const { id, action, to, alt, tags } = body ?? {};
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof action !== "string") return fail("bad_request", 400);
  await ensureSchema();
  if (action === "edit") {
    // Bounded before cleaning (lib/content/library.mjs cleanAlt and cleanTags do the rest).
    if (alt !== undefined && (typeof alt !== "string" || alt.length > 1000)) return fail("bad_request", 400);
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 50 || tags.some((t) => typeof t !== "string" || t.length > 200))) return fail("bad_request", 400);
    const out = await editImage(db(), { id, alt: alt as string | undefined, tags: tags as string[] | undefined });
    if (!out.image) return fail(out.error ?? "not_found", out.error === "not_found" ? 404 : 400);
    return NextResponse.json({ image: out.image }, { headers: PRIVATE });
  }
  if (!Object.hasOwn(ACTIONS, action) || (to != null && typeof to !== "string")) return fail("bad_request", 400);
  const out = await decide(db(), { id, action, to: (to as string | undefined) ?? null, actor: `admin:${who.login}`, now: new Date() });
  if (!out.image) return fail(out.error ?? "not_found", out.error === "wrong_status" ? 409 : out.error === "bad_request" ? 400 : 404);
  return NextResponse.json({ image: out.image }, { headers: PRIVATE });
}
