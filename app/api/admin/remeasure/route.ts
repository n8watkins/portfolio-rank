import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { isKnownPortfolio } from "@/lib/roster";
import { markForced, readFreshness } from "@/lib/freshness.mjs";

// The admin's "Re-measure" on a portfolio page (lib/freshness.mjs): every
// check of the site is due again at once. Lighthouse and the polish check
// run on the next view (the portfolio page asks again right away), the
// screenshots and link checks in tonight's free checks.
//   GET  /api/admin/remeasure?url=<listed portfolio>   { forcedAt, checkedAt, changedAt }
//   POST /api/admin/remeasure { url }                  { forcedAt }
// Admin only (ADMIN_GITHUB_ID); anyone else gets 401 or 403.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };
const iso = (v: unknown) => (v == null ? null : new Date(Number(v)).toISOString());

export async function GET(req: Request) {
  const who = await requireAdmin();
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  const url = new URL(req.url).searchParams.get("url");
  if (!url || !isKnownPortfolio(url)) return NextResponse.json({ error: "unknown_url" }, { status: 404, headers: PRIVATE });
  await ensureSchema();
  const row = await readFreshness(db(), url);
  return NextResponse.json({ forcedAt: iso(row?.forced_at), checkedAt: iso(row?.checked_at), changedAt: iso(row?.changed_at) }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url || !isKnownPortfolio(url)) return NextResponse.json({ error: "unknown_url" }, { status: 404, headers: PRIVATE });
  await ensureSchema();
  const at = await markForced(db(), url);
  return NextResponse.json({ forcedAt: iso(at) }, { headers: PRIVATE });
}
