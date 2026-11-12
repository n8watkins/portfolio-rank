import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { isKnownPortfolio } from "@/lib/roster";
import { pendingRemovals, undoRemoval } from "@/lib/games/claims.mjs";
import { PRIVATE, fail, forgetPool } from "@/lib/games/server";

// Owners' removals, for the admin (ADMIN_GITHUB_ID). Always on, like claims.
// GET  /api/admin/removals -> { pending: [{ url, removeAfter, requestedBy, login }],
//                               removed: [{ url, removedAt }] } (the latest 100)
// POST /api/admin/removals { url, action: "undo" } -> { state, wasRemoved }
//   takes a removal back, held or done; when it had taken effect
//   (wasRemoved), the weekly exclusions pull request may already have added
//   it to data/excluded.json, whose entry then comes out by hand.
//   400 bad_request, 401/403, 404 not_removed
// Undos go to the claims audit log under "admin:<login>".
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  await ensureSchema();
  const removed = (await db().execute("SELECT url, removed_at FROM portfolio_owner WHERE removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT 100")).rows.map((r) => ({
    url: String(r.url),
    removedAt: String(r.removed_at),
  }));
  return NextResponse.json({ pending: await pendingRemovals(db()), removed }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const admin = await requireAdminPost(req);
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  let body: { url?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url || body?.action !== "undo" || !isKnownPortfolio(url)) return fail("bad_request", 400);
  await ensureSchema();
  const out = await undoRemoval(db(), { url, actor: `admin:${admin.login}`, now: new Date() });
  if (!out.ok) return fail(out.error ?? "not_removed", 404);
  // The site is back in the quiz pool.
  await db().execute({ sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] });
  forgetPool();
  return NextResponse.json({ state: out.state, wasRemoved: out.wasRemoved }, { headers: PRIVATE });
}
