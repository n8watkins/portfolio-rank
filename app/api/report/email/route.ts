import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { validEmail } from "@/lib/email/gate.mjs";
import { clientIp, ipKey, sameOrigin } from "@/lib/polls/server";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { verifyTurnstile } from "@/lib/turnstile";
import { createOneTimeLink } from "@/lib/grader/links.mjs";
import { authSecret, emailGate, readJsonBody, siteBase } from "@/lib/grader/server";
import { PRIVATE, currentPlayer, fail, gamesEnabled, off, overLimit, portfolioName, rateLimited } from "@/lib/games/server";

// POST /api/report/email { url, email, turnstileToken? } (GAMES_V2)
// Emails a one-time link to the portfolio's report (app/report/print), for
// visitors who don't sign in. The link (lib/grader/links.mjs, scope
// "report-link") works once, for 24 hours.
//   202 { sent: true }
//   400 bad_request | bad_email | unknown_portfolio, 403 bad_origin |
//   turnstile_failed, 429 rate_limited, 503 email_unavailable with reason
//   "unavailable" (no transport), "capped" (a cap of the email gate) or
//   "failed" (the provider refused it)
// Caps: 5 an hour per browser and per network here, then the shared email
// gate's (lib/email/gate.mjs, kind "report-link"): the site-wide and
// per-kind daily caps and at most 3 emails a day to one address. The
// address is used to send and is not stored; the gate keeps a keyed hash.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

export async function POST(req: Request) {
  if (!gamesEnabled()) return off();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const body = await readJsonBody(req, 4096);
  if (!body) return fail("bad_request", 400);
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return fail("bad_request", 400);
  const email = validEmail(body.email);
  if (!email) return fail("bad_email", 400);
  if (!isKnownPortfolio(url)) return fail("unknown_portfolio", 400);

  await ensureSchema();
  const client = db();
  if (await isHidden(url)) return fail("unknown_portfolio", 400);
  const gate = await emailGate(client);
  if (!gate.enabled) return fail("email_unavailable", 503, { reason: "unavailable" });
  const player = (await currentPlayer({ create: true }))!;
  const ip = clientIp(req);
  const over = await overLimit([
    { key: `report-email:b:${player.browser || player.id}`, limit: 5, windowMs: HOUR },
    ...(ip ? [{ key: `report-email:ip:${ipKey(ip)}`, limit: 5, windowMs: HOUR }] : []),
  ]);
  if (over) return rateLimited(over);
  if ((await verifyTurnstile(body.turnstileToken, ip, { action: "report-email" })) === "failed") return fail("turnstile_failed", 403);

  // A link whose email isn't sent simply expires unused (as for grade reports).
  const { token } = await createOneTimeLink(client, { scope: "report-link", subject: url, secret: authSecret() });
  const link = `${siteBase()}/report/print?t=${encodeURIComponent(token)}`;
  const name = portfolioName(url);
  const res = await gate.send({
    kind: "report-link",
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
  if (!res.sent) {
    if (res.reason === "bad_address") return fail("bad_email", 400);
    const reason = res.reason === "no_transport" ? "unavailable" : String(res.reason).startsWith("cap:") ? "capped" : "failed";
    return fail("email_unavailable", 503, { reason });
  }
  return NextResponse.json({ sent: true }, { status: 202, headers: PRIVATE });
}
