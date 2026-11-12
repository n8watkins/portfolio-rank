import { db, ensureSchema } from "@/lib/db";
import { networkOf } from "@/lib/grader/caps.mjs";
import { clientIp, emailGate, sameOrigin } from "@/lib/grader/server";
import { confirmEmail } from "@/lib/newsletter/emails.mjs";
import { fail, json, keyed, limited, newsletterEnabled, nlSecret, siteBase } from "@/lib/newsletter/server";
import { cleanSource, subscribe } from "@/lib/newsletter/store.mjs";
import { normalizeEmail } from "@/lib/signin/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /api/newsletter/subscribe { email, turnstileToken?, source?, form? }:
// signs an address up for the blog newsletter and emails it a confirm link
// (AUTOMATION.md "Newsletter"). The same steps as the sign-in emails, each
// refusing before the next costs anything:
//   1. NEWSLETTER_ENABLED, this site's Origin and a JSON body of at most 4 KB;
//   2. a plausible address;
//   3. attempts per network (keyed hash of the IPv4 address or IPv6 /64):
//      10 an hour, 30 a day;
//   4. Cloudflare Turnstile (action "newsletter"), refused on the deployed
//      Workers without the secret;
//   5. sign-ups per address (keyed hash): 3 a day;
//   6. the confirm email, through the shared gate (kind "newsletter-confirm",
//      20 a day, 3 per address) and the newsletter's mailroom app.
// The answer is the same { ok: true } for a new, pending or confirmed
// address, so the form says nothing about who is subscribed.
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = { networkHour: 10, networkDay: 30, addressDay: 3 };

export async function POST(req: Request) {
  if (!newsletterEnabled()) return fail("not_found", 404);
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
  const overAddr = await limited([
    { key: `nl:ad:${who}`, limit: LIMITS.addressDay, windowMs: DAY },
  ]);
  if (overAddr) return fail("rate_limited", 429, { retryAfterSec: overAddr.retryAfterSec }, { "retry-after": String(overAddr.retryAfterSec) });

  const out = await subscribe(db(), { email, source: cleanSource(body.source, body.form), secret: nlSecret() });
  if (out.action === "none" || !out.token) return json({ ok: true });
  const base = siteBase();
  const mail = confirmEmail({ link: `${base}/newsletter/confirm?t=${out.token}`, site: base });
  const gate = await emailGate(db(), { via: "mailroom-news" });
  const sent = await gate.send({ kind: "newsletter-confirm", to: email, ...mail, key: `nlc-${out.token.slice(0, 16)}` });
  if (!sent.sent) {
    console.error(JSON.stringify({ event: "newsletter_confirm_not_sent", reason: String(sent.reason ?? "").replace(/[^\s@]+@[^\s@]+/g, "[email]") }));
    return fail(sent.reason === "cap:recipient" ? "rate_limited" : "email_unavailable", sent.reason === "cap:recipient" ? 429 : 503);
  }
  return json({ ok: true });
}
