import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { adminErrorStatus, requireAdmin } from "@/lib/admin";
import { kit, kitFormId, newsletterEnabled, newsletterLive, subscriberCount } from "@/lib/newsletter/server";

// GET /api/admin/newsletter/kit: the Kit setup check, read through the
// Worker so the API key never leaves it. Returns the account (name, plan,
// sending address), every form, the email templates, the latest broadcasts,
// the confirmed count, which form sign-ups use, and the switches.
// ?probe=draft also proves broadcasts can be created on this plan: it makes a
// draft (send_at null, so nothing is ever sent), then deletes it.
//
// Who may call it: the admin; and on staging only, a request carrying the
// staging gate key (x-staging-gate, the same secret the gate already
// checks), so the setup can be checked from a terminal without a browser
// session. Never cached, never indexed.
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

function stagingKey(req: Request): boolean {
  if (process.env.SITE_ENV !== "staging") return false;
  const want = String(process.env.STAGING_GATE_KEY ?? "");
  const got = String(req.headers.get("x-staging-gate") ?? "");
  if (!want || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

export async function GET(req: Request) {
  if (!stagingKey(req)) {
    const who = await requireAdmin();
    if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  }
  const client = kit();
  if (!client) return NextResponse.json({ error: "no_kit_key" }, { status: 409, headers: PRIVATE });
  const [diag, count, formId, live] = await Promise.all([client.diagnostics(), subscriberCount({ fresh: true }), kitFormId(), newsletterLive()]);
  let probe: unknown = null;
  if (new URL(req.url).searchParams.get("probe") === "draft") {
    try {
      const made = await client.createBroadcast({
        subject: "[setup check] PortfolioRank draft, never sent",
        content: "<p>A draft made by PortfolioRank's Kit setup check. It is deleted at once and never sent.</p><p><a href=\"{{ unsubscribe_url }}\">Unsubscribe</a><br>{{ address }}</p>",
        description: "PortfolioRank setup check (deleted at once)",
        sendAt: null,
      });
      let deleted: unknown = false;
      try {
        deleted = (await client.deleteBroadcast(made.id)).ok;
      } catch (e) {
        deleted = String((e as Error)?.message ?? e);
      }
      probe = { created: true, id: made.id, deleted };
    } catch (e) {
      probe = { created: false, status: (e as { status?: number })?.status ?? null, error: String((e as Error)?.message ?? e) };
    }
  }
  return NextResponse.json(
    {
      ...diag,
      confirmedSubscribers: count.count,
      signupFormId: formId,
      switches: { NEWSLETTER_ENABLED: newsletterEnabled(), live, mode: process.env.SITE_ENV === "staging" ? "draft" : (process.env.KIT_BROADCAST_MODE ?? "draft") },
      probe,
    },
    { headers: PRIVATE }
  );
}
