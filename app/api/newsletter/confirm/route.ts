import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/grader/server";
import { fail, json, newsletterEnabled } from "@/lib/newsletter/server";
import { confirmSubscription } from "@/lib/newsletter/store.mjs";

// POST /api/newsletter/confirm { t }: uses a confirm link (works once, for 3
// days). The link in the email opens /newsletter/confirm, whose button posts
// here, so mail scanners that open links can't confirm anyone.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!newsletterEnabled()) return fail("not_found", 404);
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const raw = await req.text().catch(() => "");
  if (raw.length > 1024) return fail("bad_request", 400);
  let t: unknown;
  try {
    t = (JSON.parse(raw || "null") ?? {}).t;
  } catch {
    return fail("bad_request", 400);
  }
  await ensureSchema();
  const out = await confirmSubscription(db(), String(t ?? ""));
  if ("error" in out) return fail(out.error as string, out.error === "expired" ? 410 : 400);
  return json({ ok: true });
}
