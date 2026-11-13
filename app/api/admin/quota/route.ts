import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { adminUsage } from "@/lib/admin/usage";
import { adminLimits } from "@/lib/admin/limits.mjs";
import { db } from "@/lib/db";
import { PRIMARY_MODEL } from "@/pipeline/gemini.mjs";

// The admin usage data as JSON (the /admin/usage page shows the same,
// lib/admin/usage.ts says what is in it), with every free limit against its
// cap as `limits` (the /admin/limits page, lib/admin/limits.mjs). Read-only, and only for the GitHub
// account in ADMIN_GITHUB_ID.
//   GET /api/admin/quota[?days=30]
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store" };

export async function GET(req: Request) {
  const who = await requireAdmin();
  if ("error" in who) {
    return NextResponse.json({ error: who.error }, { status: who.error === "signin_required" ? 401 : 403, headers: PRIVATE });
  }
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 30, 1), 90);
  const usage = await adminUsage({ days });
  const limits = await adminLimits(db(), { env: process.env, model: PRIMARY_MODEL });
  return NextResponse.json({ ...usage, limits }, { headers: PRIVATE });
}
