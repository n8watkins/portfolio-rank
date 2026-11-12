import { NextResponse } from "next/server";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { sendTestEmail } from "@/lib/newsletter/admin";
import { maskEmail } from "@/lib/signin/store.mjs";

// POST /api/admin/newsletter/test {}: emails the owner (OWNER_EMAIL) the
// newsletter email of the latest live post, marked as a test. Admin only,
// this site's Origin and a JSON body (lib/admin.ts requireAdminPost).
// -> { ok: true, to: "na***@...", post } or { error } (409 no_owner_email or
// no_post, 503 when the gate or mailroom refused, with the reason).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const admin = await requireAdminPost(req);
  if ("error" in admin) return NextResponse.json({ error: admin.error }, { status: adminErrorStatus(admin.error) });
  await ensureSchema();
  const out = await sendTestEmail(db() as unknown as Parameters<typeof sendTestEmail>[0]);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.error === "no_owner_email" || out.error === "no_post" ? 409 : 503, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ok: true, to: maskEmail(out.to), post: out.post }, { headers: { "cache-control": "no-store" } });
}
