import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { PRIVATE, fail } from "@/lib/games/server";
import { listReports, markHandled, reopenReports } from "@/lib/problem-reports/store.mjs";
import { CAP_ALERT_KEY } from "@/lib/problem-reports/intake.mjs";
import { reconcileAlerts } from "@/pipeline/alerts.mjs";

// Visitors' "Report a problem" notes (lib/problem-reports/store.mjs), for the
// admin (ADMIN_GITHUB_ID) only; shown on /admin/review.
// GET  /api/admin/problem-reports -> { open: [group], handled: [group] }, each
//      group { key, url, count, reasons, reports, first, last, handledAt, handledBy }
// POST /api/admin/problem-reports
//      { action: "handle", reports: [{ id, updatedAt }] (1 to 500) }
//        -> { changed, stale }  handles each report only if it is still as
//        the page showed it (updatedAt); a resent one stays open (stale)
//      { action: "reopen", ids: number[] (1 to 500) } -> { changed }
//   400 bad_request, 401/403
// Handling also clears the "day's cap" owner alert (/admin/alerts), since
// the owner is looking at the reports. Neither changes anything about the
// site: a report is information only.
export const dynamic = "force-dynamic";

const MAX = 500;
const isId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  await ensureSchema();
  return NextResponse.json(await listReports(db()), { headers: PRIVATE });
}

export async function POST(req: Request) {
  const admin = await requireAdminPost(req);
  if ("error" in admin) return fail(admin.error, adminErrorStatus(admin.error));
  let body: { ids?: unknown; reports?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  if (body?.action === "handle") {
    const reports = Array.isArray(body.reports) ? body.reports : [];
    const items = reports.filter(
      (r): r is { id: number; updatedAt: string } => r && typeof r === "object" && isId(r.id) && typeof r.updatedAt === "string" && ISO.test(r.updatedAt)
    );
    if (items.length === 0 || items.length > MAX || items.length !== reports.length || new Set(items.map((r) => r.id)).size !== items.length) return fail("bad_request", 400);
    await ensureSchema();
    const out = await markHandled(db(), { items: items.map(({ id, updatedAt }) => ({ id, updatedAt })), actor: `admin:${admin.login}`, now: new Date() });
    if (out.changed) await reconcileAlerts(db(), { conditions: [], scope: (key: string) => key === CAP_ALERT_KEY });
    return NextResponse.json(out, { headers: PRIVATE });
  }
  if (body?.action === "reopen") {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
    if (ids.length === 0 || ids.length > MAX || !ids.every(isId)) return fail("bad_request", 400);
    await ensureSchema();
    return NextResponse.json({ changed: await reopenReports(db(), { ids }) }, { headers: PRIVATE });
  }
  return fail("bad_request", 400);
}
