import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { emailAvailable, sendEmail } from "@/lib/email";
import { clientIp, ipKey, sameOrigin, verifyTurnstile } from "@/lib/polls/server";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { SITE_URL } from "@/lib/site";
import { createReportLink, dropReportLink } from "@/lib/games/report.mjs";
import { PRIVATE, currentPlayer, fail, gamesEnabled, off, overLimit, portfolioName, rateLimited } from "@/lib/games/server";

// POST /api/report/email { url, email, turnstileToken? } (GAMES_V2)
// Emails a one-time link to the portfolio's report (app/report/print), for
// visitors who don't sign in. The link works once, for 24 hours.
//   202 { sent: true }
//   400 bad_request | bad_email | unknown_portfolio, 403 bad_origin |
//   turnstile_failed, 429 rate_limited, 503 email_unavailable (no sender
//   wired yet, the day's email cap is spent, or the send failed)
// Caps: 3 a day per address, 5 an hour per browser and per network, and
// the email gate's site-wide daily cap (lib/email.ts). The address is used
// to send and is not stored; only a keyed hash counts against its cap.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export async function POST(req: Request) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  let body: { url?: unknown; email?: unknown; turnstileToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const url = typeof body?.url === "string" ? body.url : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!url) return fail("bad_request", 400);
  if (email.length > 254 || !EMAIL.test(email)) return fail("bad_email", 400);
  if (!isKnownPortfolio(url)) return fail("unknown_portfolio", 400);

  await ensureSchema();
  if (await isHidden(url)) return fail("unknown_portfolio", 400);
  if (!emailAvailable()) return fail("email_unavailable", 503);
  const player = (await currentPlayer({ create: true }))!;
  const ip = clientIp(req);
  const secret = process.env.AUTH_SECRET ?? "";
  const addressKey = createHash("sha256").update(`report-email\n${secret}\n${email.toLowerCase()}`).digest("base64url").slice(0, 22);
  const over = await overLimit([
    { key: `report-email:b:${player.browser || player.id}`, limit: 5, windowMs: HOUR },
    { key: `report-email:to:${addressKey}`, limit: 3, windowMs: DAY },
    ...(ip ? [{ key: `report-email:ip:${ipKey(ip)}`, limit: 5, windowMs: HOUR }] : []),
  ]);
  if (over) return rateLimited(over);
  if ((await verifyTurnstile(body.turnstileToken, ip, "report-email")) === "failed") return fail("turnstile_failed", 403);

  const token = randomBytes(32).toString("base64url");
  await createReportLink(db(), { url, token, now: new Date() });
  const origin = (() => {
    try {
      return new URL(process.env.AUTH_URL ?? SITE_URL).origin;
    } catch {
      return SITE_URL;
    }
  })();
  const link = `${origin}/report/print?t=${token}`;
  const name = portfolioName(url);
  const sent = await sendEmail({
    to: email,
    subject: `Your PortfolioRank report for ${name}`,
    text: [
      `Here is the PortfolioRank report for ${name} (${url}).`,
      "",
      `Open it here: ${link}`,
      "",
      "The link works once, for 24 hours. On the page, \"Save as PDF\" keeps a copy.",
      "You get this email because someone asked for it on PortfolioRank; nothing else will be sent.",
    ].join("\n"),
  });
  if (sent !== "sent") {
    await dropReportLink(db(), token);
    return fail("email_unavailable", 503, { reason: sent });
  }
  return NextResponse.json({ sent: true }, { status: 202, headers: PRIVATE });
}
