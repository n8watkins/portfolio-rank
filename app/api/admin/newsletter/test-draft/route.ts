import { NextResponse } from "next/server";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { postFromRow } from "@/lib/content/store.mjs";
import { db, ensureSchema } from "@/lib/db";
import { createTestDraft } from "@/lib/newsletter/send.mjs";
import { kit, siteBase } from "@/lib/newsletter/server";

// POST /api/admin/newsletter/test-draft {}: the admin's "Create a test draft
// in Kit". The newest live post's email (else the newest post) becomes a Kit
// draft broadcast marked [test], never scheduled, so it reaches nobody; the
// owner opens it in Kit and uses Kit's own "send test email". Works whether
// the newsletter switch is on or off. Admin only, this site's Origin and a
// JSON body. -> { id, url, subject } | 409 { error: "no_kit_key" | "no_post" }
// | 502 { error: "kit_refused", status, reason }
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  const client = kit();
  if (!client) return NextResponse.json({ error: "no_kit_key" }, { status: 409, headers: PRIVATE });
  await ensureSchema();
  const now = new Date().toISOString();
  const live = (await db().execute({ sql: "SELECT * FROM posts WHERE status = 'published' AND publish_at <= ? ORDER BY publish_at DESC LIMIT 1", args: [now] })).rows[0];
  const row = live ?? (await db().execute({ sql: "SELECT * FROM posts ORDER BY created_at DESC LIMIT 1", args: [] })).rows[0];
  if (!row) return NextResponse.json({ error: "no_post" }, { status: 409, headers: PRIVATE });
  try {
    const made = await createTestDraft(client, postFromRow(row), { base: siteBase() });
    console.log(JSON.stringify({ event: "newsletter.test_draft", broadcast: made.id, by: who.login }));
    return NextResponse.json(made, { headers: PRIVATE });
  } catch (e) {
    return NextResponse.json(
      { error: "kit_refused", status: (e as { status?: number })?.status ?? null, reason: String((e as Error)?.message ?? e).slice(0, 200) },
      { status: 502, headers: PRIVATE }
    );
  }
}
