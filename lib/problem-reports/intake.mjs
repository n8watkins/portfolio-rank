// What POST /api/problem-reports does, in order, apart from the request
// itself (app/api/problem-reports/route.ts reads the body, the visitor and
// the network, and hands them here, so the steps are tested without a
// server: tests/problem-reports.test.mjs). Each step refuses before the next
// costs anything, in the same order as the newsletter sign-up (network
// limits, the bot check, then the per-person limit):
//   1. a site address, a known reason and a short note (./store.mjs);
//   2. attempts per network, as keyed hashes: the IPv4 address or IPv6 /64
//      NETWORK_HOUR an hour and NETWORK_DAY a day, and the IPv6 /48
//      NETWORK48_DAY a day. A request without an address (no
//      cf-connecting-ip) shares one "unknown" network, as the newsletter's
//      does, so leaving the header off never skips these limits;
//   3. Cloudflare Turnstile, action "problem-report" (lib/turnstile.ts:
//      refused on the deployed Workers without the secret);
//   4. the site has a live profile (the route's `known`: the same checks
//      that decide whether /p/<url> answers 404);
//   5. reports per visitor (a keyed hash of the signed browser cookie, or of
//      the account when signed in): VISITOR_DAY a day;
//   6. a resend: the visitor's open report on this site gets the new reason
//      and note; it charges neither cap below, since it adds no row;
//   7. new reports per site: SITE_DAY a day; then new reports across the
//      whole site: ALL_DAY a day. Past either the answer is the same
//      thank-you and nothing more is stored. Reaching a cap is logged once a
//      day (per site, or once for the whole site), and the whole-site cap
//      also raises a quiet owner alert (/admin/alerts) through `alert`;
//   8. stored.
import { createHash } from "node:crypto";
import { REASON_KEYS, cleanNote, cleanSiteUrl, openReportId, saveReport } from "./store.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The limits.
 * - A visitor who finds several bad screenshots while browsing can report
 *   each: VISITOR_DAY 10.
 * - A shared network (an office, a campus) has room for a few people:
 *   NETWORK_HOUR 6 and NETWORK_DAY 20 per IPv4 address or IPv6 /64.
 * - One IPv6 /48 (usually one organisation or one home line) gets three
 *   /64s' worth, so stepping through /64s buys little: NETWORK48_DAY 60.
 * - One site keeps at most SITE_DAY 30 new reports a day.
 * - The whole site keeps at most ALL_DAY 200 new reports a day: about one in
 *   ten listed sites (2,154 on 2026-11-23), far above any real day and more
 *   than one person reviews in a sitting, while still bounding what a
 *   botnet that passes Turnstile could write.
 */
export const LIMITS = { NETWORK_HOUR: 6, NETWORK_DAY: 20, NETWORK48_DAY: 60, VISITOR_DAY: 10, SITE_DAY: 30, ALL_DAY: 200 };

export { TURNSTILE_ACTION } from "./store.mjs";

/** The shared network name for a request without an address. */
export const UNKNOWN_NETWORK = "unknown";

/** The owner alert raised when the whole-site cap is reached (quiet: shown on /admin/alerts, not emailed). */
export const CAP_ALERT_KEY = "problem-reports:daily-cap";

const siteKey = (url) => createHash("sha256").update(url).digest("base64url").slice(0, 22);
const thanks = { status: 200, body: { ok: true } };

/**
 * body: the parsed JSON body ({ url, reason, note?, turnstileToken? }) or
 * null when it was missing, too big or not an object. visitor, network and
 * network48 are keyed hashes (network is never empty: the route passes the
 * keyed UNKNOWN_NETWORK without an address; network48 is "" for IPv4).
 * verify(token) answers "ok", "skipped" or "failed"; known(url) whether the
 * site has a live profile; rateLimit(key, { limit, windowMs, now }) is
 * lib/polls/store.mjs's, bound to the database; log(fields) writes one log
 * line; alert(condition) records an owner alert.
 * Returns { status, body, headers? } for the route to send.
 * @param {{ db: any, body: Record<string, any> | null, visitor: string, network: string, network48?: string,
 *   verify: (token: unknown) => Promise<string>, known: (url: string) => Promise<boolean>,
 *   rateLimit: (key: string, opts: { limit: number, windowMs: number, now: number }) => Promise<{ ok: boolean, retryAfterSec: number }>,
 *   log?: (fields: any) => void, alert?: (condition: any) => Promise<void>, now?: number }} options
 * @returns {Promise<{ status: number, body: Record<string, unknown>, headers?: Record<string, string> }>}
 */
export async function takeReport({ db, body, visitor, network, network48 = "", verify, known, rateLimit, log = () => {}, alert = async () => {}, now = Date.now() }) {
  if (!body || !visitor || !network) return { status: 400, body: { error: "bad_request" } };
  const url = cleanSiteUrl(body.url);
  if (!url) return { status: 400, body: { error: "bad_request" } };
  if (typeof body.reason !== "string" || !REASON_KEYS.includes(body.reason)) return { status: 400, body: { error: "bad_reason" } };
  const cleaned = cleanNote(body.note);
  if (cleaned.error) return { status: 400, body: { error: cleaned.error } };

  const limited = async (limits) => {
    for (const [key, limit, windowMs] of limits) {
      const hit = await rateLimit(key, { limit, windowMs, now });
      if (!hit.ok) return { status: 429, body: { error: "rate_limited", retryAfterSec: hit.retryAfterSec }, headers: { "retry-after": String(hit.retryAfterSec) } };
    }
    return null;
  };

  const networks = [
    ["report:nh:" + network, LIMITS.NETWORK_HOUR, HOUR],
    ["report:nd:" + network, LIMITS.NETWORK_DAY, DAY],
  ];
  if (network48) networks.push(["report:n48:" + network48, LIMITS.NETWORK48_DAY, DAY]);
  const overNetwork = await limited(networks);
  if (overNetwork) return overNetwork;

  if ((await verify(body.turnstileToken)) === "failed") return { status: 403, body: { error: "turnstile_failed" } };
  if (!(await known(url))) return { status: 404, body: { error: "unknown_site" } };

  const overVisitor = await limited([["report:vd:" + visitor, LIMITS.VISITOR_DAY, DAY]]);
  if (overVisitor) return overVisitor;

  const save = () => saveReport(db, { url, reason: body.reason, note: cleaned.note, reporter: visitor, now: new Date(now) });
  // A resend replaces the visitor's open report: no new row, so no cap is charged.
  if (await openReportId(db, { url, reporter: visitor })) {
    await save();
    return thanks;
  }

  const site = siteKey(url);
  if (!(await rateLimit("report:sd:" + site, { limit: LIMITS.SITE_DAY, windowMs: DAY, now })).ok) {
    if ((await rateLimit("report:sd-logged:" + site, { limit: 1, windowMs: DAY, now })).ok) {
      log({ event: "problem_reports_site_cap", reason: "site_day_cap", route: "/api/problem-reports", site, limit: LIMITS.SITE_DAY });
    }
    return thanks;
  }
  if (!(await rateLimit("report:all", { limit: LIMITS.ALL_DAY, windowMs: DAY, now })).ok) {
    if ((await rateLimit("report:all-logged", { limit: 1, windowMs: DAY, now })).ok) {
      log({ event: "problem_reports_daily_cap", reason: "all_day_cap", route: "/api/problem-reports", limit: LIMITS.ALL_DAY });
      await alert({
        key: CAP_ALERT_KEY,
        kind: "problem",
        title: "Visitor reports hit the day's cap",
        detail: `More than ${LIMITS.ALL_DAY} new "Report a problem" reports came in within a day; the rest were thanked and not stored. Look at /admin/review. The alert clears when you mark reports handled.`,
        quiet: true,
      });
    }
    return thanks;
  }

  await save();
  return thanks;
}
