import { ensureSchema } from "@/lib/db";
import { networkOf } from "@/lib/grader/caps.mjs";
import { clientIp, sameOrigin } from "@/lib/grader/server";
import { fail, json, keyed, kit, kitFormId, limited, newsletterLive, siteBase } from "@/lib/newsletter/server";
import { cleanSource } from "@/lib/newsletter/store.mjs";
import { normalizeEmail } from "@/lib/signin/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /api/newsletter/subscribe { email, turnstileToken?, source?, form? }:
// signs an address up for the blog newsletter through Kit (AUTOMATION.md
// "Newsletter"). Kit keeps the list and sends its own confirm email (double
// opt-in on the KIT_FORM_ID form); we store no address, only rate-limit
// counters under keyed hashes. Each step refuses before the next costs
// anything:
//   1. the newsletter is live (NEWSLETTER_ENABLED and the owner's switch),
//      this site's Origin and a JSON body of at most 4 KB;
//   2. a plausible address;
//   3. attempts per network (keyed hash of the IPv4 address or IPv6 /64):
//      10 an hour, 30 a day;
//   4. Cloudflare Turnstile (action "newsletter"), refused on the deployed
//      Workers without the secret;
//   5. sign-ups per address (keyed hash): 3 a day;
//   6. Kit: the address as an unconfirmed subscriber, added to the form.
// The answer is the same { ok: true } for a new, pending or confirmed
// address, so the form says nothing about who is subscribed.
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = { networkHour: 10, networkDay: 30, addressDay: 3 };

export async function POST(req: Request) {
  if (!(await newsletterLive())) return fail("not_found", 404);
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const raw = await req.text().catch(() => "");
  if (raw.length > 4096) return fail("bad_request", 400);
  let body: { email?: unknown; turnstileToken?: unknown; source?: unknown; form?: unknown };
  try {
    body = JSON.parse(raw || "null") ?? {};
  } catch {
    return fail("bad_request", 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) return fail("bad_email", 400);

  await ensureSchema();
  const ip = clientIp(req);
  const net = keyed("newsletter-net", networkOf(ip) || ip || "unknown");
  const overNet = await limited([
    { key: `nl:nh:${net}`, limit: LIMITS.networkHour, windowMs: HOUR },
    { key: `nl:nd:${net}`, limit: LIMITS.networkDay, windowMs: DAY },
  ]);
  if (overNet) return fail("rate_limited", 429, { retryAfterSec: overNet.retryAfterSec }, { "retry-after": String(overNet.retryAfterSec) });

  if ((await verifyTurnstile(body.turnstileToken, ip, { action: "newsletter" })) === "failed") return fail("turnstile_failed", 403);

  const who = keyed("newsletter-addr", email);
  const overAddr = await limited([{ key: `nl:ad:${who}`, limit: LIMITS.addressDay, windowMs: DAY }]);
  if (overAddr) return fail("rate_limited", 429, { retryAfterSec: overAddr.retryAfterSec }, { "retry-after": String(overAddr.retryAfterSec) });

  const client = kit();
  const formId = await kitFormId();
  if (!client || !formId) {
    console.error(JSON.stringify({ event: "newsletter_kit_missing", key: Boolean(client), form: Boolean(formId) }));
    return fail("email_unavailable", 503);
  }
  const source = cleanSource(body.source, body.form);
  try {
    await client.subscribe(email, { formId, referrer: `${siteBase()}${source?.startsWith("/") ? source.split(" ")[0] : "/"}` });
  } catch (e) {
    // KitError messages never carry the address (lib/newsletter/kit.mjs).
    const status = (e as { status?: number })?.status ?? 0;
    console.error(JSON.stringify({ event: "newsletter_kit_failed", status, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return fail("email_unavailable", 503);
  }
  return json({ ok: true });
}
