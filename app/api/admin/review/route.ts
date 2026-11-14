import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { isKnownPortfolio } from "@/lib/roster";
import { decideReviews, listReviews, undoReviews } from "@/lib/reviews/store.mjs";
import { purgeProfile } from "@/lib/edge-purge";
import { PRIVATE, fail, forgetPool } from "@/lib/games/server";

// The owner's review queue (lib/reviews/store.mjs), for the admin
// (ADMIN_GITHUB_ID) only.
// GET  /api/admin/review -> { pending: [review], autoApplied: [review], decided: [review] (latest 200 each) }
// POST /api/admin/review { ids: number[] (1 to 200), action: "confirm" | "reject" | "undo" }
//   -> { results: [{ id, url, ok, error?, applied?, reversed?, note? }] }
//   Confirm applies each change through the pipeline's own paths (see the
//   store) and records who and when; Reject records the decision only; Undo
//   takes back any decision (the owner's, the review rule's or another
//   rule's): what it changed is reversed (store planUndo) and the row waits
//   for the owner again. Confirm and Undo on a row in another state answer
//   ok: false, error "wrong_status". The page asks before every one of these
//   (components/admin/ConfirmButton.tsx).
//   400 bad_request, 401/403
// Decisions are recorded under "admin:<login>".
export const dynamic = "force-dynamic";

const MAX_IDS = 200;

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  await ensureSchema();
  return NextResponse.json(await listReviews(db()), { headers: PRIVATE });
}

export async function POST(req: Request) {
  const admin = await requireAdminPost(req);
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  let body: { ids?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids)] : [];
  const action = body?.action;
  if (
    (action !== "confirm" && action !== "reject" && action !== "undo") ||
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
  ) {
    return fail("bad_request", 400);
  }
  await ensureSchema();
  const actor = `admin:${admin.login}`;
  const results =
    action === "undo"
      ? await undoReviews(db(), { ids, actor, now: new Date() })
      : await decideReviews(db(), { ids, action, actor, onFeed: isKnownPortfolio, now: new Date() });
  const changed = results.filter((r) => r.ok && action !== "reject" && r.url);
  if (changed.length) {
    // What a profile shows changed (worker/edge-cache.ts keeps profiles a day), and so may the quiz pool.
    await Promise.all(changed.map((r) => purgeProfile(r.url as string)));
    await db().execute({ sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] });
    forgetPool();
  }
  return NextResponse.json({ results }, { headers: PRIVATE });
}
