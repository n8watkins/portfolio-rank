import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { PRIVATE, fail } from "@/lib/games/server";
import { listReports, markHandled, reopenReports } from "@/lib/problem-reports/store.mjs";

// Visitors' "Report a problem" notes (lib/problem-reports/store.mjs), for the
// admin (ADMIN_GITHUB_ID) only; shown on /admin/review.
// GET  /api/admin/problem-reports -> { open: [site], handled: [site] }, each
//      site { url, count, reasons, reports, first, last, handledAt, handledBy }
// POST /api/admin/problem-reports { ids: number[] (1 to 500), action: "handle" | "reopen" }
//      -> { changed }  Handle records who and when; Reopen puts them back.
//   400 bad_request, 401/403
// Neither changes anything about the site: a report is information only.
export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  await ensureSchema();
  return NextResponse.json(await listReports(db()), { headers: PRIVATE });
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
    (action !== "handle" && action !== "reopen") ||
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
  ) {
    return fail("bad_request", 400);
  }
  await ensureSchema();
  const changed =
    action === "handle" ? await markHandled(db(), { ids, actor: `admin:${admin.login}`, now: new Date() }) : await reopenReports(db(), { ids });
  return NextResponse.json({ changed }, { headers: PRIVATE });
}
