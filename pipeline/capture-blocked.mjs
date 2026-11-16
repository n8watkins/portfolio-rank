// A capture that does not show the site (owner, 2026-11-13: "never grade a
// gate"; 2026-11-16: bot checks and empty sites are simply not added). After
// the click-throughs and waits of the nightly capture (pipeline/capture.mjs,
// pipeline/splash.mjs), capturedBlocked decides whether the screen still
// stands in for the site. A blocked capture is never stored, never graded
// and never sent to the owner's review queue:
//
//   - a site with no good capture yet is recorded as a failed capture
//     (status 'error', reason "capture blocked: ..."), retried on later
//     nights with backoff (pipeline/roster.mjs captureRetryAt), kept off the
//     list meanwhile (lib/hidden.mjs), and, while it stays blocked, failed by
//     the weekly health check until it is confirmed down and excluded as
//     broken (pipeline/health.mjs, pipeline/exclusions.mjs kind "down");
//   - a refresh of a site that already has a good capture keeps that capture
//     and records nothing, like any failed refresh.
//
// The rule, from the recheck-543 experiment (scripts/experiments/
// recheck-543-capture.mjs blockedWhy, and BOT_CHECK in recheck-543.mjs),
// first match wins:
//   1. a bot or security check stands in for the site (short page only);
//   2. still a splash gate or loader after the click-through;
//   3. still a mode picker after the click;
//   4. still a dialog on top after the click;
//   5. under BLOCK_MAX_WORDS words AND no link to another site.
// Rule 5 needs both: a minimalist one-screen portfolio has few words but
// links out (GitHub, LinkedIn). The code cannot tell an unrendered page from
// a truly blank one, and does not need to: both are "retry, then broken".

import { detectGate } from "./splash.mjs";

export const BLOCK_MAX_WORDS = 40;
/** A bot check is a short page; a portfolio that jokes "I'm not a robot" in its about text is not one. */
export const BOT_CHECK_MAX_WORDS = 150;
/** Every blocked capture's failure reason starts with this (the health check reads it). */
export const BLOCKED_PREFIX = "capture blocked: ";

/**
 * A bot or security check in place of the site: Vercel Security Checkpoint,
 * Cloudflare's "Just a moment..." and "Verifying you are human", "Confirm you
 * are human" and the like.
 */
export const BOT_CHECK =
  /security checkpoint|failed to verify your browser|performing security verification|confirm you are human|checking your browser|verify(ing)? (you are|you're) (a )?human|needs to review the security of your connection|are you a robot|not a robot|just a moment\.\.\.|attention required/i;

const wordsOf = (t) => String(t ?? "").split(/\s+/).filter(Boolean).length;

/**
 * Why a finished capture does not show the site, or null when it does.
 * `text`: the page's visible text after the passes and the scroll-through;
 * `title`: the document title; `outboundLinks`: how many other hosts the
 * page links to (countOutboundLinks); `splash`, `modal`, `mode`: what
 * passSplashGate, passModal and passModePicker returned on the desktop view.
 * @param {{ text?: string, title?: string, outboundLinks?: number, splash?: any, modal?: any, mode?: any }} capture
 */
export function capturedBlocked({ text = "", title = "", outboundLinks = 0, splash = null, modal = null, mode = null } = {}) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const n = wordsOf(t);
  if (n <= BOT_CHECK_MAX_WORDS && (BOT_CHECK.test(t) || BOT_CHECK.test(String(title ?? "")))) return "a bot or security check stood in for the site";
  const loader = /(^|[^\d])\d{1,3}\s?%/.test(t) && n <= 6;
  if (splash?.passed === false || detectGate(t).gate || loader) return "still a gate or loader after the click-through";
  if (mode?.passed === false) return "still a mode picker after the click";
  if (modal?.passed === false) return "still a dialog on top after the click";
  if (n < BLOCK_MAX_WORDS && !(Number(outboundLinks) > 0)) return `${n} words and no outbound links`;
  return null;
}

/** Whether a stored capture failure reason is a blocked capture's. */
export const isBlockedReason = (reason) => String(reason ?? "").startsWith(BLOCKED_PREFIX);

/** In the browser: how many other hosts the page links to (http and https links only). */
export function countOutboundLinks() {
  const here = location.hostname.replace(/^www\./, "");
  const hosts = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href"), location.href);
      if (/^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") !== here) hosts.add(u.hostname);
    } catch {
      // not a link
    }
  }
  return hosts.size;
}
