import { NextResponse } from "next/server";
import { adminErrorStatus, requireAdmin } from "@/lib/admin";
import { postFromRow } from "@/lib/content/store.mjs";
import { db, ensureSchema } from "@/lib/db";
import { emailForPost } from "@/lib/newsletter/send.mjs";
import { siteBase } from "@/lib/newsletter/server";

// GET /api/admin/newsletter/preview: the newsletter email of the newest live
// post (else the newest post of any kind) as the HTML page Kit gets, with
// stand-ins for Kit's unsubscribe link and mailing address. Admin only; it
// changes nothing and sends nothing.
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if ("error" in admin) return NextResponse.json({ error: admin.error }, { status: adminErrorStatus(admin.error) });
  await ensureSchema();
  const now = new Date().toISOString();
  const live = (await db().execute({ sql: "SELECT * FROM posts WHERE status = 'published' AND publish_at <= ? ORDER BY publish_at DESC LIMIT 1", args: [now] })).rows[0];
  const row = live ?? (await db().execute({ sql: "SELECT * FROM posts ORDER BY created_at DESC LIMIT 1", args: [] })).rows[0];
  if (!row) return NextResponse.json({ error: "no_post" }, { status: 409 });
  const mail = emailForPost(postFromRow(row), { base: siteBase(), preview: true });
  return new Response(mail.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      // The email's own HTML: no scripts, and images from anywhere (covers can be stock photos).
      "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
    },
  });
}
