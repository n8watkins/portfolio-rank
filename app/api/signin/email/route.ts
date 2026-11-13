import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { networkOf } from "@/lib/grader/caps.mjs";
import { clientIp, emailGate, sameOrigin } from "@/lib/grader/server";
import { rateLimit } from "@/lib/polls/store.mjs";
import { SITE_URL } from "@/lib/site";
import { issueToken, normalizeEmail, safeCallback, TOKEN_TTL_MS } from "@/lib/signin/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /api/signin/email { email, turnstileToken?, callbackUrl? }: emails a
// one-time sign-in link (AUTOMATION.md "Email sign-in"). In this order, each
// step refusing before the next costs anything:
//   1. this site's Origin and a JSON body of at most 4 KB;
//   2. a plausible address;
//   3. attempts per network (the IPv4 address or IPv6 /64, kept as a keyed
//      hash): 10 an hour, 30 a day;
//   4. Cloudflare Turnstile (action "signin-email"), refused on the deployed
//      Workers without the secret;
//   5. links per address (keyed hash): 3 an hour, 6 a day;
//   6. the link: 15 minutes, works once, only its hash stored;
//   7. the email, through the shared gate (lib/email/gate.mjs, kind "signin")
//      and the mailroom (MAILROOM), each with its own caps.
// The answer is the same 200 for any address that got this far, new or not.
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SIGNIN_LIMITS = {
  networkHour: 10,
  networkDay: 30,
  addressHour: 3,
  addressDay: 6,
};

const fail = (error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: { "cache-control": "no-store", ...headers } });

const keyed = (kind: string, value: string) =>
  createHmac("sha256", String(process.env.AUTH_SECRET ?? "")).update(`${kind}\n${value}`).digest("base64url").slice(0, 22);

async function limited(hits: { key: string; limit: number; windowMs: number }[]) {
  const now = Date.now();
  for (const h of hits) {
    const r = await rateLimit(db(), h.key, { limit: h.limit, windowMs: h.windowMs, now });
    if (!r.ok) return r;
  }
  return null;
}

function signInEmail(link: string) {
  const minutes = Math.round(TOKEN_TTL_MS / 60000);
  const subject = "Your PortfolioRank sign-in link";
  const text = `Sign in to PortfolioRank:\n\n${link}\n\nThe link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email: nobody can sign in without it.\n`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:Inter,system-ui,-apple-system,sans-serif;color:#111114">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:700">Sign in to PortfolioRank</td></tr>
<tr><td style="padding:0 28px 20px;font-size:15px;line-height:1.5;color:#4b4b55">Press the button to finish signing in. The link works once and expires in ${minutes} minutes.</td></tr>
<tr><td style="padding:0 28px 24px"><a href="${link}" style="display:inline-block;background:#f5a524;color:#111114;font-weight:600;font-size:15px;text-decoration:none;padding:12px 20px;border-radius:10px">Sign in</a></td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;line-height:1.5;color:#6b6b75">If you didn't ask for this, ignore this email: nobody can sign in without it.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const raw = await req.text().catch(() => "");
  if (raw.length > 4096) return fail("bad_request", 400);
  let body: { email?: unknown; turnstileToken?: unknown; callbackUrl?: unknown };
  try {
    body = JSON.parse(raw || "null") ?? {};
  } catch {
    return fail("bad_request", 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) return fail("bad_email", 400);

  await ensureSchema();
  const ip = clientIp(req);
  const net = keyed("signin-net", networkOf(ip) || ip || "unknown");
  const overNet = await limited([
    { key: `signin:nh:${net}`, limit: SIGNIN_LIMITS.networkHour, windowMs: HOUR },
    { key: `signin:nd:${net}`, limit: SIGNIN_LIMITS.networkDay, windowMs: DAY },
  ]);
  if (overNet) return fail("rate_limited", 429, { retryAfterSec: overNet.retryAfterSec }, { "retry-after": String(overNet.retryAfterSec) });

  if ((await verifyTurnstile(body.turnstileToken, ip, { action: "signin-email" })) === "failed") return fail("turnstile_failed", 403);

  const who = keyed("signin-addr", email);
  const overAddr = await limited([
    { key: `signin:ah:${who}`, limit: SIGNIN_LIMITS.addressHour, windowMs: HOUR },
    { key: `signin:ad:${who}`, limit: SIGNIN_LIMITS.addressDay, windowMs: DAY },
  ]);
  if (overAddr) return fail("rate_limited", 429, { retryAfterSec: overAddr.retryAfterSec }, { "retry-after": String(overAddr.retryAfterSec) });

  const token = await issueToken(db(), { email, callback: safeCallback(body.callbackUrl) });
  const base = (process.env.SITE_URL || SITE_URL).replace(/\/$/, "");
  const mail = signInEmail(`${base}/signin/email?t=${token}`);
  const gate = await emailGate(db(), { via: "mailroom" });
  const sent = await gate.send({ kind: "signin", to: email, ...mail, key: `signin-${token.slice(0, 16)}` });
  if (!sent.sent) {
    console.error(JSON.stringify({ event: "signin_email_not_sent", reason: String(sent.reason ?? "").replace(/[^\s@]+@[^\s@]+/g, "[email]") }));
    return fail(sent.reason === "cap:recipient" ? "rate_limited" : "email_unavailable", sent.reason === "cap:recipient" ? 429 : 503);
  }
  return NextResponse.json({ sent: true }, { headers: { "cache-control": "no-store" } });
}
