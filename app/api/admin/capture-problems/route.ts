import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin } from "@/lib/admin";
import { captureProblems } from "@/lib/capture-problems.mjs";

// The Capture problems list (lib/capture-problems.mjs, the admin page
// /admin/capture-problems) as JSON:
//   GET /api/admin/capture-problems   { A, B, C, D, measuring, counts }
// Read-only. Admin only (ADMIN_GITHUB_ID); anyone else gets 401 or 403.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  await ensureSchema();
  return NextResponse.json(await captureProblems(db()), { headers: PRIVATE });
}
