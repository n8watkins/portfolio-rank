import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { ACTIONS, decide, librarySummary, listImages } from "@/lib/content/library.mjs";

// The image library's review (docs/CONTENT-ENGINE.md, "The image library"),
// only for the GitHub login in ADMIN_GITHUB_LOGIN; the page is /admin/images.
//   GET  /api/admin/library -> { summary, images }, newest first
//   POST /api/admin/library { id, action: "keep" | "drop" | "retire" }
//     -> { image }; 400 bad_request, 401, 403 (forbidden or bad_origin),
//        404 not_found, 409 wrong_status
// keep and drop apply to pending and rejected-auto images, retire to
// approved ones. POSTs must come from this site with a JSON body (CSRF).
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
  let body: { id?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const { id, action } = body ?? {};
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) return fail("bad_request", 400);
  await ensureSchema();
  const out = await decide(db(), { id, action, actor: `admin:${who.login}`, now: new Date() });
  if (!out.image) return fail(out.error ?? "not_found", out.error === "wrong_status" ? 409 : 404);
  return NextResponse.json({ image: out.image }, { headers: PRIVATE });
}
