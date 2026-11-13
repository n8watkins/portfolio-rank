import { NextResponse } from "next/server";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { newsletterEnabled } from "@/lib/newsletter/server";
import { setSwitch, switchLog } from "@/lib/newsletter/switch.mjs";

// POST /api/admin/newsletter/switch { on: boolean }: the owner's "Turn
// newsletter on/off" (lib/newsletter/switch.mjs), admin only, this site's
// Origin and a JSON body (lib/admin.ts requireAdminPost). Every change is
// logged with the admin's login. -> { on, at, by, live, log }, where live
// also needs NEWSLETTER_ENABLED.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  const body = (await req.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ error: "bad_request" }, { status: 400, headers: PRIVATE });
  await ensureSchema();
  const s = await setSwitch(db(), body.on, { by: who.login });
  return NextResponse.json({ ...s, live: s.on && newsletterEnabled(), log: await switchLog(db(), { limit: 5 }) }, { headers: PRIVATE });
}
