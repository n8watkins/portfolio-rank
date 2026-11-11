import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { contentMode, listPosts, recentRuns } from "@/lib/content/store.mjs";

// The content engine's review data, until the redesign's admin page shows
// it (docs/CONTENT-ENGINE.md, "What the owner sees"): drafts (dry-run
// drafts and posts the weekly cap held back), published, dropped or
// unpublished posts, each with its Markdown body, fact sheet, checks,
// images (source, licence, credit, review) and outside claims with their
// sources, plus the latest content runs and the current CONTENT_MODE.
// Read-only, and only for the GitHub login in ADMIN_GITHUB_LOGIN.
//   GET /api/admin/content[?status=draft|published|dropped|unpublished|all][&limit=20]
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };
const STATUSES = new Set(["draft", "published", "dropped", "unpublished", "all"]);

export async function GET(req: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.error === "signin_required" ? 401 : 403, headers: PRIVATE });
  }
  const params = new URL(req.url).searchParams;
  const status = params.get("status") ?? "draft";
  if (!STATUSES.has(status)) return NextResponse.json({ error: "bad_status" }, { status: 400, headers: PRIVATE });
  const limit = Math.min(Math.max(Number(params.get("limit")) || 20, 1), 100);
  await ensureSchema();
  const client = db();
  const [posts, runs] = await Promise.all([listPosts(client, { status, limit }), recentRuns(client, { limit: 30 })]);
  return NextResponse.json({ mode: contentMode(process.env.CONTENT_MODE), status, posts, runs }, { headers: PRIVATE });
}
