// A capture that does not show the site (owner, 2026-11-13: "never grade a
// gate"; 2026-11-16: bot checks and empty sites are simply not added). After
// the click-throughs and waits of the nightly capture (pipeline/capture.mjs,
// pipeline/splash.mjs), capturedBlocked decides whether the screen still
// stands in for the site. A blocked capture is never stored and never graded:
//
//   - a site with no good capture yet is recorded as a failed capture
//     (status 'error', reason "capture blocked: ..."), retried on later
//     nights with backoff (pipeline/roster.mjs captureRetryAt) and kept off
//     the list meanwhile (lib/hidden.mjs);
//   - blank, gated or nearly empty: while it stays blocked, the weekly health
//     check fails it until it is confirmed down and excluded as broken
//     (pipeline/health.mjs, pipeline/exclusions.mjs kind "down");
//   - a bot wall (BOT_WALL; owner, 2026-11-16: "Bot-walled sites can be sent
//     to me for review"): never failed or excluded by the health check (it
//     stays inconclusive) and marked portfolios.needs_review = 1 for the
//     owner's review, which a later change turns into a review-queue row;
//   - a refresh of a site that already has a good capture keeps that capture
//     and only waits out a backoff, like any failed refresh.
//
// The rule, from the recheck-543 experiment (scripts/experiments/
// recheck-543-capture.mjs blockedWhy, and BOT_CHECK in recheck-543.mjs),
// first match wins:
//   1. a bot or security check stands in for the site (isBotWallPage);
//   2. still a splash gate or loader after the click-through (a plain word
//      such as "Start" only as an element's whole text, ./splash.mjs);
//   3. still a mode picker after the click;
//   4. still a dialog on top after the click;
//   5. under BLOCK_MAX_WORDS words AND no link to another site, no links to
//      two pages of its own (or one page and a contact link).
// Rule 5 needs both: a minimalist one-screen portfolio has few words but
// links out (GitHub, LinkedIn) or to its own pages. The code cannot tell an
// unrendered page from a truly blank one, and does not need to: both are
// "retry, then broken". Rule 1 comes first, so a bot wall is never mistaken
// for an empty page.
//
// A page that rule 5 would block but that shows a canvas, video or image
// over a good part of the screen (MEDIA_MIN_COVER) is MEDIA_ONLY instead: it
// may be a canvas-only portfolio (Flutter web, three.js) or a preloader that
// never finished, which the words cannot tell apart. The capture never
// stores it as live: a blank frame is blocked, anything else goes to the
// owner's review (MEDIA_REVIEW_REASON, pipeline/capture.mjs).
//
// Before these, the main document's HTTP status (httpVerdict): an error page
// is never stored as the site, whatever it shows.

import { detectGate, findGateTarget } from "./splash.mjs";

export const BLOCK_MAX_WORDS = 40;
/** A bot check is a short page; a portfolio that jokes "I'm not a robot" in its about text is not one. */
export const BOT_CHECK_MAX_WORDS = 150;
/** A canvas, video or image covering this much of the first screen makes a wordless page MEDIA_ONLY. */
export const MEDIA_MIN_COVER = 0.3;
/** Every blocked capture's failure reason starts with this (the health check reads it). */
export const BLOCKED_PREFIX = "capture blocked: ";
/**
 * The bot wall's reason: its stored failure reason is BLOCKED_PREFIX +
 * BOT_WALL (isBotWallReason), the one blocked kind that goes to the owner
 * for review instead of ending as broken.
 */
export const BOT_WALL = "a bot or security check stood in for the site";
/** capturedBlocked's answer for a page with only a canvas, video or image and nothing else that shows a site. */
export const MEDIA_ONLY = "only a canvas, video or image, with no text or links";
/**
 * A failed capture the owner decides on. Not a blocked reason
 * (isBlockedReason is false), so the health check never fails it on the
 * capture's word; the row carries needs_review = 1.
 */
export const OWNER_REVIEW_PREFIX = "needs owner review: ";
export const MEDIA_REVIEW_REASON = `${OWNER_REVIEW_PREFIX}${MEDIA_ONLY}`;
/** A MEDIA_ONLY page whose screen is one flat colour: nothing was drawn. */
export const BLANK_FRAME = "a blank screen: no text and nothing drawn";

/**
 * A bot or security check in place of the site: Vercel Security Checkpoint,
 * Cloudflare's "Just a moment..." and "Verifying you are human", "Confirm you
 * are human" and the like.
 */
export const BOT_CHECK =
  /security checkpoint|failed to verify your browser|performing security verification|confirm you are human|checking your browser|verify(ing)? (you are|you're) (a )?human|needs to review the security of your connection|just a moment\.\.\.|attention required/i;

/**
 * A page asking the visitor to prove they are not a robot ("make sure you're
 * not a robot", "Are you a robot?", "Enter the characters you see below",
 * "complete the CAPTCHA"). A portfolio can say "definitely not a robot" or
 * carry Google's reCAPTCHA notice, so it counts only on a page that is
 * mostly the question (isBotWallPage).
 */
const ROBOT_ASK =
  /\b(verify|confirm|prove|show|make sure)\b[^.!?]{0,30}\bnot a (ro)?bot\b|\bare you a (ro)?bot\b|\b(complete|solve|enter|type|fill in)\b[^.!?]{0,30}\b(re)?captcha\b|\bcaptcha (below|required|verification|challenge)\b|enter the characters you see/i;
/** The notice reCAPTCHA and hCaptcha ask every page that uses them to show: not a challenge. */
const CAPTCHA_NOTICE = /(this site is )?protected by (re)?captcha and the google privacy policy and terms of service apply\.?|(this site is )?protected by hcaptcha and its privacy policy and terms of service apply\.?/gi;

/** A firewall or access block in place of the site (Cloudflare's "Error 1020 Access denied", a WAF page). */
const ACCESS_WALL = /access denied|access to this (page|site|website) (has been|is) (denied|blocked)|error 10\d\d|security service to protect itself|request (has been |was )?blocked|blocked by (the )?(firewall|waf|security)|bot (protection|detection)|ddos protection|ray id/i;

/** A rate limit: the site is up but turned this visit away for now (retried, never reviewed). */
const RATE_LIMITED = /rate.?limit|too many requests|banned you temporarily/i;

const wordsOf = (t) => String(t ?? "").split(/\s+/).filter(Boolean).length;
const flat = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/**
 * Rule 1, on its own: whether the page is a bot or security check standing
 * in for the site. The health check asks exactly this.
 *   - challenge wording (BOT_CHECK) on a page of BOT_CHECK_MAX_WORDS or fewer,
 *     in the text or the title;
 *   - a request to prove you are not a robot (ROBOT_ASK, the reCAPTCHA notice
 *     left out): in a title of a page that short; in the text of a nearly
 *     empty page (BLOCK_MAX_WORDS); or in the text of a page that short with a
 *     challenge on it (a captcha widget or a form with an image and a text
 *     box, `challenge`) and no navigation of its own (at most
 *     WALL_MAX_SITE_LINKS links to its own pages, `siteLinks`: terms and
 *     privacy).
 * @param {{ text?: string, title?: string, siteLinks?: number, challenge?: boolean }} page
 */
export function isBotWallPage({ text = "", title = "", siteLinks = 0, challenge = false } = {}) {
  const t = flat(text);
  const ttl = String(title ?? "");
  const n = wordsOf(t);
  if (n > BOT_CHECK_MAX_WORDS) return false;
  if (BOT_CHECK.test(t) || BOT_CHECK.test(ttl)) return true;
  const ask = flat(t.replace(CAPTCHA_NOTICE, " "));
  if (ROBOT_ASK.test(ttl.replace(CAPTCHA_NOTICE, " "))) return true;
  if (!ROBOT_ASK.test(ask)) return false;
  return wordsOf(ask) <= BLOCK_MAX_WORDS || (challenge === true && (Number(siteLinks) || 0) <= WALL_MAX_SITE_LINKS);
}

/** A wall links to its legal pages at most (terms, privacy); a site has navigation. */
const WALL_MAX_SITE_LINKS = 2;

/**
 * A plain gate word ("Start", "Enter") counts only as an element's whole text
 * (./splash.mjs). `gateElement` is what the page said (findGateTarget);
 * without it, a line of the text that is only the word stands in.
 */
function gateShown(raw, t, gateElement) {
  const g = detectGate(t);
  if (!g.gate) return false;
  if (!g.exact) return true;
  if (typeof gateElement === "boolean") return gateElement;
  return String(raw ?? "")
    .split(/\n+/)
    .some((l) => l.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim() === g.phrase);
}

/**
 * Why a finished capture does not show the site, or null when it does.
 * `text`: the page's visible text after the passes and the scroll-through;
 * `title`: the document title; `outboundLinks`: how many other hosts the
 * page links to; `splash`, `modal`, `mode`: what passSplashGate, passModal
 * and passModePicker returned on the desktop view.
 * Optional, from pageEvidence (readBlockedInputs fills them in):
 * `siteLinks` (other pages of the same site it links to), `contactLinks`
 * (mailto: and tel: links), `mediaCover` (the share of the first screen the
 * largest canvas, video or image covers, 0 to 1), `challenge` (a captcha
 * widget or challenge form is shown), `gateElement` (whether a plain gate
 * word is an element's whole text).
 * Returns MEDIA_ONLY for a page that only media might make a site (see the header).
 * @param {{ text?: string, title?: string, outboundLinks?: number, splash?: any, modal?: any, mode?: any, siteLinks?: number, contactLinks?: number, mediaCover?: number, challenge?: boolean, gateElement?: boolean }} capture
 */
export function capturedBlocked({
  text = "",
  title = "",
  outboundLinks = 0,
  splash = null,
  modal = null,
  mode = null,
  siteLinks = 0,
  contactLinks = 0,
  mediaCover = 0,
  challenge = false,
  gateElement = undefined,
} = {}) {
  const t = flat(text);
  const n = wordsOf(t);
  if (isBotWallPage({ text, title, siteLinks, challenge })) return BOT_WALL;
  const loader = (/(^|[^\d])\d{1,3}\s?%/.test(t) && n <= 6) || (/\bloading\b|please wait/i.test(t) && n <= 3);
  if (splash?.passed === false || gateShown(text, t, gateElement) || loader) return "still a gate or loader after the click-through";
  if (mode?.passed === false) return "still a mode picker after the click";
  if (modal?.passed === false) return "still a dialog on top after the click";
  if (n < BLOCK_MAX_WORDS) {
    const own = Number(siteLinks) || 0;
    const showsSite = Number(outboundLinks) > 0 || (n > 0 && (own >= 2 || (own >= 1 && Number(contactLinks) > 0)));
    if (!showsSite) return Number(mediaCover) >= MEDIA_MIN_COVER ? MEDIA_ONLY : `${n} words and no outbound links`;
  }
  return null;
}

/**
 * Whether the main document's HTTP status rules the capture out, from the
 * last response of the page's own navigation (a challenge that reloads into
 * the site counts as the site). null when the status is fine (below 400, or
 * none known), else { status, reason, needsReview }:
 *
 *   - a bot or security check (challenge wording, Cloudflare's
 *     cf-mitigated: challenge, or a firewall's "Access denied" on 401/403):
 *     the bot wall, for the owner's review (BOT_WALL_REASON);
 *   - a 401, 403, 404 or 410 whose page otherwise shows a whole site (a host
 *     that answers 403 with the real page, a single-page app served from a
 *     copied 404.html): also the owner's review, since a browser shows it
 *     but its status says error;
 *   - a rate limit (429, or rate-limit wording): an error, retried with backoff;
 *   - 404 or 410: dead, like the plain pre-check (pipeline/gate.mjs httpGate);
 *   - anything else 400 and up: an error ("HTTP 503"), retried with backoff.
 *
 * An error page is never stored as the site, and never replaces a good capture.
 * @param {{ status?: number, text?: string, title?: string, cfMitigated?: string, shown?: Parameters<typeof capturedBlocked>[0] }} doc
 */
export function httpVerdict({ status = 0, text = "", title = "", cfMitigated = "", shown = undefined } = {}) {
  const s = Number(status) || 0;
  if (s < 400) return null;
  const t = flat(text);
  const ttl = String(title ?? "");
  const n = wordsOf(t);
  const wall = { status: "error", reason: BOT_WALL_REASON, needsReview: true };
  if (/challenge/i.test(String(cfMitigated ?? "")) || isBotWallPage({ ...(shown ?? {}), text, title })) return wall;
  if (s === 429 || RATE_LIMITED.test(t) || RATE_LIMITED.test(ttl)) return { status: "error", reason: `HTTP ${s} (rate limited)`, needsReview: false };
  if ((s === 401 || s === 403) && (ACCESS_WALL.test(t) || ACCESS_WALL.test(ttl))) return wall;
  if ([401, 403, 404, 410].includes(s) && n >= BOT_CHECK_MAX_WORDS && shown && capturedBlocked({ ...shown, text, title }) === null) {
    return { status: "error", reason: `${BOT_WALL_REASON} (HTTP ${s}, but the page shows a site)`, needsReview: true };
  }
  if (s === 404 || s === 410) return { status: "dead", reason: `HTTP ${s}`, needsReview: false };
  return { status: "error", reason: `HTTP ${s}`, needsReview: false };
}

/** Whether a stored capture failure reason is a blocked capture's (any kind, the bot wall included). */
export const isBlockedReason = (reason) => String(reason ?? "").startsWith(BLOCKED_PREFIX);

/** The stored capture failure reason of a bot-walled site (the door in lib/reviews/door.mjs matches it in SQL). */
export const BOT_WALL_REASON = `${BLOCKED_PREFIX}${BOT_WALL}`;

/** Whether a stored capture failure reason is the bot wall's: it starts with BOT_WALL_REASON, so a suffix added later still matches. */
export const isBotWallReason = (reason) => String(reason ?? "").startsWith(BOT_WALL_REASON);

/**
 * In the browser: what besides words shows a site, and whether a challenge
 * is on screen. { outboundLinks, siteLinks, contactLinks, mediaCover,
 * challenge }: other hosts linked (http and https), other pages of this site
 * linked (not this page or an anchor on it), mailto: and tel: links, the
 * share of the first screen the largest visible canvas, video, image or
 * Flutter view covers, and whether a captcha widget or a challenge form (a
 * text box and an image in one form) is shown.
 */
export function pageEvidence() {
  const here = location.hostname.replace(/^www\./, "");
  const path = (u) => u.pathname.replace(/\/+$/, "") || "/";
  const thisPage = path(new URL(location.href));
  const hosts = new Set();
  const pages = new Set();
  let contactLinks = 0;
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href"), location.href);
      if (u.protocol === "mailto:" || u.protocol === "tel:") contactLinks++;
      else if (!/^https?:$/.test(u.protocol)) continue;
      else if (u.hostname.replace(/^www\./, "") !== here) hosts.add(u.hostname);
      else if (path(u) !== thisPage) pages.add(path(u));
    } catch {
      // not a link
    }
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) >= 0.05;
  };
  let mediaCover = 0;
  for (const el of document.querySelectorAll("canvas, video, img, svg, flt-glass-pane, flutter-view")) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    mediaCover = Math.max(mediaCover, (w * h) / (vw * vh));
  }
  const widget = [...document.querySelectorAll("iframe[src], [data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile, input[name*=captcha i], img[src*=captcha i]")].some(
    (el) => shown(el) && (el.tagName !== "IFRAME" || /captcha|challenge|turnstile/i.test(el.getAttribute("src") ?? ""))
  );
  const challengeForm = [...document.querySelectorAll("form")].some(
    (f) => shown(f) && [...f.querySelectorAll("input:not([type]), input[type=text]")].some(shown) && [...f.querySelectorAll("img")].some(shown)
  );
  return { outboundLinks: hosts.size, siteLinks: pages.size, contactLinks, mediaCover: Math.round(mediaCover * 100) / 100, challenge: widget || challengeForm };
}

/**
 * Everything capturedBlocked and httpVerdict read from a loaded Playwright
 * page, after the passes: its text, title, links, media, challenge and
 * whether a plain gate word left on it is an element's whole text. When the
 * page cannot be read (a transient evaluate failure), `fallbackText` stands
 * in, so a hiccup never reads as an empty page.
 * @param {import("playwright").Page} page
 * @param {string} [fallbackText]
 */
export async function readBlockedInputs(page, fallbackText = "") {
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => String(fallbackText ?? ""));
  const title = await page.title().catch(() => "");
  const evidence = await page.evaluate(pageEvidence).catch(() => ({ outboundLinks: 0, siteLinks: 0, contactLinks: 0, mediaCover: 0, challenge: false }));
  const g = detectGate(flat(text));
  const gateElement = g.gate && g.exact ? await page.evaluate(findGateTarget, [g.phrase, true, false]).catch(() => false) : undefined;
  return { text: String(text ?? ""), title, ...evidence, gateElement };
}
