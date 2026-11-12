import { db, ensureSchema } from "@/lib/db";
import { fail, json, nlSecret, siteBase } from "@/lib/newsletter/server";
import { unsubscribe } from "@/lib/newsletter/store.mjs";

// POST /api/newsletter/unsubscribe?s=<subscriber id>&k=<key>: unsubscribes
// at once. It is the List-Unsubscribe URL of every newsletter email, so mail
// apps' one-click unsubscribe (RFC 8058: a POST with the body
// "List-Unsubscribe=One-Click", from the mail provider, not this site) lands
// here, and the button on /newsletter/unsubscribe posts here too. The key in
// the link is the only proof needed, so there is no Origin check. It works
// even while NEWSLETTER_ENABLED is off: leaving must always work.
// A GET (someone opening the link in a browser) goes to the page with the
// button, so link scanners never unsubscribe anyone.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  await ensureSchema();
  const out = await unsubscribe(db(), { id: url.searchParams.get("s") ?? "", key: url.searchParams.get("k") ?? "", secret: nlSecret() });
  if ("error" in out) return fail("invalid", 400);
  return json({ ok: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const to = new URL("/newsletter/unsubscribe", siteBase());
  for (const k of ["s", "k"]) {
    const v = url.searchParams.get(k);
    if (v) to.searchParams.set(k, v);
  }
  return Response.redirect(to.toString(), 303);
}
