// What POST /api/problem-reports does, in order, apart from the request
// itself (app/api/problem-reports/route.ts reads the body, the visitor and
// the network, and hands them here, so the steps are tested without a
// server: tests/problem-reports.test.mjs). Each step refuses before the next
// costs anything, the same order as the other public forms (the grade
// request and the newsletter sign-up):
//   1. a site address, a known reason and a short note (./store.mjs);
//   2. attempts per network (a keyed hash of the IPv4 address or IPv6 /64):
//      NETWORK_HOUR an hour and NETWORK_DAY a day;
//   3. attempts per visitor (a keyed hash of the signed browser cookie or
//      the account): VISITOR_DAY a day;
//   4. Cloudflare Turnstile, action "problem-report" (lib/turnstile.ts:
//      refused on the deployed Workers without the secret);
//   5. the site is one PortfolioRank has a profile for;
//   6. new reports per site: SITE_DAY a day. Past that the answer is the same
//      thank-you, and nothing more is stored: the owner already has plenty
//      about that site, and one person can't bury the list in it;
//   7. stored: one open report per visitor and site, a second send replaces
//      the first's reason and note.
import { createHash } from "node:crypto";
import { REASON_KEYS, cleanNote, cleanSiteUrl, saveReport } from "./store.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The limits. A visitor who finds several bad screenshots while browsing can
 * report each (10 a day); a shared network (an office, a campus) gets room
 * for a few people (20 a day, 6 an hour); one site keeps at most 30 new
 * reports a day.
 */
export const LIMITS = { NETWORK_HOUR: 6, NETWORK_DAY: 20, VISITOR_DAY: 10, SITE_DAY: 30 };

export { TURNSTILE_ACTION } from "./store.mjs";

const siteKey = (url) => createHash("sha256").update(url).digest("base64url").slice(0, 22);

/**
 * body: the parsed JSON body ({ url, reason, note?, turnstileToken? }) or
 * null when it was missing, too big or not an object. visitor and network
 * are keyed hashes ("" when unknown). verify(token) answers "ok", "skipped"
 * or "failed"; known(url) whether the site has a profile; rateLimit(key,
 * { limit, windowMs, now }) is lib/polls/store.mjs's, bound to the database.
 * Returns { status, body, headers? } for the route to send.
 */
export async function takeReport({ db, body, visitor, network, verify, known, rateLimit, now = Date.now() }) {
  if (!body || !visitor) return { status: 400, body: { error: "bad_request" } };
  const url = cleanSiteUrl(body.url);
  if (!url) return { status: 400, body: { error: "bad_request" } };
  if (typeof body.reason !== "string" || !REASON_KEYS.includes(body.reason)) return { status: 400, body: { error: "bad_reason" } };
  const cleaned = cleanNote(body.note);
  if (cleaned.error) return { status: 400, body: { error: cleaned.error } };

  const limits = [];
  if (network) {
    limits.push(["report:nh:" + network, LIMITS.NETWORK_HOUR, HOUR], ["report:nd:" + network, LIMITS.NETWORK_DAY, DAY]);
  }
  limits.push(["report:vd:" + visitor, LIMITS.VISITOR_DAY, DAY]);
  for (const [key, limit, windowMs] of limits) {
    const hit = await rateLimit(key, { limit, windowMs, now });
    if (!hit.ok) return { status: 429, body: { error: "rate_limited", retryAfterSec: hit.retryAfterSec }, headers: { "retry-after": String(hit.retryAfterSec) } };
  }

  if ((await verify(body.turnstileToken)) === "failed") return { status: 403, body: { error: "turnstile_failed" } };
  if (!(await known(url))) return { status: 404, body: { error: "unknown_site" } };

  const site = await rateLimit("report:sd:" + siteKey(url), { limit: LIMITS.SITE_DAY, windowMs: DAY, now });
  if (!site.ok) return { status: 200, body: { ok: true } };

  await saveReport(db, { url, reason: body.reason, note: cleaned.note, reporter: visitor, now: new Date(now) });
  return { status: 200, body: { ok: true } };
}
