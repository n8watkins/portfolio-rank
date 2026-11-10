import { cookies } from "next/headers";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { isHidden, isKnownPortfolio } from "@/lib/roster";
import { heroOf, shotBases } from "@/lib/shots";
import { SITE_URL } from "@/lib/site";
import { isVerifiedOwner, ownerState } from "@/lib/games/claims.mjs";
import { percentilesOf } from "@/lib/games/pool.mjs";
import { consumeReportLink, renderReportHtml, reportGrade } from "@/lib/games/report.mjs";
import { gamesEnabled, getPool, portfolioName, sign, unsign } from "@/lib/games/server";
import feed from "@/data/feed.json";

// The report download (GAMES_V2): a portfolio's AI report as a page made for
// printing, which the browser saves as a PDF (lib/games/report.mjs says why
// not a PDF made here).
//   GET /report/print?url=<portfolio>  for signed-in visitors
//   GET /report/print?t=<token>        a one-time link from the report email:
//       used up on the spot, it lets this browser open that one report for
//       an hour (a signed cookie), then redirects to ?url=
// 401 without either, 404 for a site not on the list or removed by its
// owner, 403 when the owner hid the grade (except for the owner), 410 for a
// used or expired link.
export const dynamic = "force-dynamic";
const PASS_COOKIE = "pr_report";
const PASS_MS = 60 * 60 * 1000;

const page = (status: number, title: string, text: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} - PortfolioRank</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#16181d;background:#fff}main{max-width:560px;margin:0 auto;padding:48px 16px}a{color:#4f46e5}</style></head><body><main><h1>${title}</h1><p>${text}</p><p><a href="/">PortfolioRank</a></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } }
  );

export async function GET(req: Request) {
  if (!gamesEnabled()) return page(404, "Not found", "There is nothing here.");
  const q = new URL(req.url).searchParams;
  await ensureSchema();
  const jar = await cookies();

  const token = q.get("t");
  if (token) {
    const url = await consumeReportLink(db(), { token, now: new Date() });
    if (!url) return page(410, "This link has been used", "Report links from email work once, for 24 hours. Ask for a new one on the portfolio's page.");
    const exp = Date.now() + PASS_MS;
    jar.set(PASS_COOKIE, sign("report", `${exp}|${url}`), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: PASS_MS / 1000,
      path: "/report",
    });
    return new Response(null, { status: 303, headers: { location: `/report/print?url=${encodeURIComponent(url)}`, "cache-control": "private, no-store" } });
  }

  const url = q.get("url") ?? "";
  if (!url || !isKnownPortfolio(url) || (await isHidden(url))) return page(404, "Not found", "That portfolio isn't on PortfolioRank.");
  const session = await auth();
  const pass = unsign("report", jar.get(PASS_COOKIE)?.value);
  const passOk = (() => {
    const m = pass?.match(/^(\d{13})\|(.+)$/);
    return Boolean(m && Number(m[1]) > Date.now() && m[2] === url);
  })();
  if (!session?.raterId && !passOk) return page(401, "Sign in to download", "Reports download for signed-in visitors, or from a one-time link sent by email.");

  const state = await ownerState(db(), url);
  if (state.hideGrade && !(session?.raterId && (await isVerifiedOwner(db(), { url, owner: session.raterId })))) {
    return page(403, "Grade hidden", "The owner of this portfolio chose to hide its grade.");
  }
  const row = (await db().execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const grade = reportGrade(row?.ai_rubric == null ? null : String(row.ai_rubric));
  if (!grade) return page(404, "No report yet", "This portfolio hasn't been graded yet.");
  const shot = (await shotBases([url])).get(url);
  const tagline = (feed as { url: string; tagline?: string }[]).find((p) => p.url === url)?.tagline ?? null;
  const html = renderReportHtml({
    name: portfolioName(url),
    url,
    tagline,
    grade,
    percentiles: percentilesOf(await getPool(), url),
    hero: shot ? heroOf(shot) : null,
    siteUrl: SITE_URL,
    now: new Date(),
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
