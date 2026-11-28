#!/usr/bin/env node
// Phase 0 capture pipeline: gate every portfolio (dead/parked/blank), then
// Playwright-capture the live ones in one visit: the whole page as one tall
// desktop and one tall phone image with small thumbnails (AVIF,
// pipeline/fullpage.mjs), the top of each cut out as the grade's hero.jpg
// and the old mobile.jpg - plus
// diagnostics (console errors, page weight, broken assets, 390px overflow,
// dark-mode support, motion from a frame difference, DOM-shape hash), the
// page's visible text (capped) and the facts code can check
// (pipeline/facts.mjs: resume, GitHub, contact, project links that load, own
// domain, footer year, pages, template), which the AI grade reads
// (pipeline/rubric.mjs). Images land in captures/<key>/ and upload to R2
// when R2_* env vars exist; results upsert into the `portfolios` table
// (Turso when TURSO_* set, else local file).
//
// Usage:
//   node pipeline/capture.mjs [--limit N] [--concurrency C] [--only substr] [--force] [--refresh N]
//   node pipeline/capture.mjs --upload-only   # backfill captures/ to R2 later
//   node pipeline/capture.mjs --recapture <file>   # exactly these listed addresses, as a refresh
//
// Failed captures are retried later with backoff (see recordCaptureFailure).
//
// --refresh N also re-captures up to N listed sites whose screenshots are due
// by the check rule (lib/freshness.mjs, AUTOMATION.md "When checks re-run"):
// the admin pressed "Re-measure" or the owner asked for a new capture
// (site_freshness.forced_at), or the capture is 90 days
// old (the nightly checks, sync-upstream.yml). Their screenshots, text,
// facts and page fingerprint are renewed; the grade stays (a site is graded
// once, owner 2026-11-21). A refresh that
// fails keeps the existing capture and never marks the site failed (whether
// a site is down is the weekly health check's call); it only waits out a
// growing backoff before it is refreshed again (lib/freshness.mjs
// recordRefreshFailure), so it does not head the refresh queue every night.
//
// Before the screenshots, a splash gate, a dialog on top and a mode picker
// are passed the way a visitor would (./splash.mjs). A capture that still
// does not show the site afterwards is not stored or graded: the main
// document answered with an error status (a bot wall's 403 goes to the
// owner's review, a 503 or a 429 is retried), the rendered page is a parked
// domain, or the screen is "blocked" (a gate, a picker, a dialog, a bot
// check, or under 40 words with nothing else that shows a site:
// ./capture-blocked.mjs). A page with no words, or only a canvas, video or
// image, is never stored as live: a flat frame is blank, anything else goes
// to the owner's review. The desktop view decides; the phone view is the same
// page resized to 390 wide, never a second visit, and never fails the capture:
// when it is not the site it is recorded as missing (narrowView). A site with
// no good capture records it as a failed capture and is retried (a bot wall
// also sets needs_review for the owner); a site that has one keeps it, and a
// refresh that met a bot wall or a page still covered by a dialog also goes
// to the owner's review list (a pending recapture_blocked row: lib/reviews/door.mjs
// blockedRefreshReview, refreshNeedsReview). A new capture that lost a portfolio sign or most of
// the text of the one it replaced is recorded (lib/capture-problems.mjs);
// the admin's Capture problems page lists all of these.
// Where a rule cannot tell, the outcome is the owner's review or "keep the
// existing capture and retry", never "stored as live" or "excluded as broken".
//
// Every site gets at most SITE_LIMIT_MS: a page that never answers (a main
// thread blocked after load) is closed, recorded as a failed capture with the
// normal backoff, and the run goes on.
import { chromium } from "playwright";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { httpGate, parkedPage, readRenderedPage, UA } from "./gate.mjs";
import { homeProjectLinks, measurePage, projectsPageFor } from "./facts.mjs";
import { readProjectsPage } from "./capture-projects.mjs";
import { pngDiff } from "./png-diff.mjs";
import { actionNote, passModal, passModePicker, passSplashGate } from "./splash.mjs";
import {
  BLANK_FRAME,
  BLOCKED_PREFIX,
  BOT_WALL,
  isBotWallReason,
  MEDIA_ONLY,
  MEDIA_REVIEW_REASON,
  capturedBlocked,
  httpVerdict,
  isBotWallPage,
  isChallengeStatus,
  readBlockedInputs,
} from "./capture-blocked.mjs";
import { flatFrame, inconclusiveGate, shot, waitForContent } from "./capture-steps.mjs";
import { normalizePageText } from "./rubric.mjs";
import {
  ACTIVE,
  captureRetryAt,
  dueForCapture,
  ensureRosterSchema,
  pipelineDb,
  syncRoster,
} from "./roster.mjs";
import { ensureFreshnessSchema, screenshotsDue } from "../lib/freshness.mjs";
import { ensureCaptureProblemSchema, recordCaptureChange } from "../lib/capture-problems.mjs";
import { blockedRefreshReview, closeBlockedRefreshReviews } from "../lib/reviews/door.mjs";
import { FRAMES, captureViewAsSeen, fullPageStorable, nextFullPage, settleFirstScreen, versionFiles } from "./fullpage.mjs";
import { deleteVersion, imagesBucket, legacyFramesOn, notStored, storeVersion } from "./shot-store.mjs";
import { SERVE_FILES, contentTypeOf } from "./shot-files.mjs";
import { rankFromCode } from "../lib/tiers-store.mjs";
import { readCookieCheck, watchRequests, withReading } from "./cookie-check.mjs";
import { MOBILE_MIN_LEFT_MS, firstFiveOf, readAtFive, readMobileFirstFive, readNow, withFirstFive } from "./first-five.mjs";

/** Now as SQLite's datetime('now') writes it ("YYYY-MM-DD HH:MM:SS", UTC), like portfolios.captured_at. */
const sqliteNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const ROOT = path.join(import.meta.dirname, "..");

const BUCKET = process.env.R2_BUCKET ?? "portfolio-rank";

// The old frames (hero.jpg, mobile.jpg; pipeline/shot-files.mjs), while
// LEGACY_FRAMES is on (pipeline/shot-store.mjs). The tall images and
// thumbnails go up versioned through storeVersion.
async function uploadDir(s3, key, dir) {
  if (!s3) return;
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  for (const f of fs.readdirSync(dir)) {
    if (!SERVE_FILES.has(f)) continue;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${key}/${f}`,
        Body: fs.readFileSync(path.join(dir, f)),
        ContentType: contentTypeOf(f),
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Per-site capture
// ---------------------------------------------------------------------------
/**
 * The row's stored capture: { fullPage (meta.fullPage or null), good (a live
 * row with screenshots), facts and chars (its facts and the length of its
 * page text, which a new capture is compared with: lib/capture-problems.mjs) }.
 */
async function storedCapture(db, url) {
  const row = (await db.execute({ sql: "SELECT status, shot_key, meta, facts, length(page_text) AS chars FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const good = Boolean(row && String(row.status) === "live" && row.shot_key != null);
  const was = { good, facts: row?.facts == null ? null : String(row.facts), chars: row?.chars == null ? null : Number(row.chars) };
  try {
    return { ...was, fullPage: JSON.parse(String(row?.meta ?? "null"))?.fullPage ?? null };
  } catch {
    return { ...was, fullPage: null };
  }
}

/** The stored facts' cookie check readings (facts.privacy), or null. */
function storedPrivacy(facts) {
  try {
    return JSON.parse(String(facts ?? "null"))?.privacy ?? null;
  } catch {
    return null;
  }
}

/** The stored facts' first five seconds (facts.first_five), or null. */
function storedFirstFive(facts) {
  try {
    return JSON.parse(String(facts ?? "null"))?.first_five ?? null;
  } catch {
    return null;
  }
}

/** The desktop visit's window. */
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

export const keyOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 16);

// A failed capture (gate said dead/parked/error, blank page, a blocked
// capture, or a crash) is never final: the row gets a retry date with
// growing backoff (roster.captureRetryAt), and the weekly health check pulls
// the retry forward once the site passes. Whether a site is shown is decided
// by the health check (pipeline/health.mjs), not by one capture attempt.
// `needsReview` also sets portfolios.needs_review = 1 (a bot wall, for the
// owner's review); without it the column is left as it is.
export async function recordCaptureFailure(db, url, name, status, reason, { needsReview = false } = {}) {
  const row = (
    await db.execute({ sql: "SELECT capture_attempts FROM portfolios WHERE url = ?", args: [url] })
  ).rows[0];
  const attempts = Number(row?.capture_attempts ?? 0) + 1;
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, reason, checked_at, capture_attempts, retry_at, needs_review)
          VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET status=excluded.status,
            reason=excluded.reason, checked_at=excluded.checked_at,
            capture_attempts=excluded.capture_attempts, retry_at=excluded.retry_at,
            needs_review=MAX(portfolios.needs_review, excluded.needs_review)`,
    args: [url, name, status, reason, attempts, captureRetryAt(attempts), needsReview ? 1 : 0],
  });
}

// A failed refresh (see the header): the good capture is not touched; the
// site only waits out the same growing backoff a failed capture gets
// (roster.captureRetryAt) in lib/freshness.mjs's refresh_failures, which
// screenshotsDue reads. The table exists once ensureFreshnessSchema ran (main
// runs it first). `needsReview` (refreshNeedsReview decides) also puts the
// site on the owner's review list: a pending recapture_blocked row
// (lib/reviews/door.mjs blockedRefreshReview, the durable record), and sets
// portfolios.needs_review = 1, which his "Mark checked" leaves as it is (the
// weekly health check rewrites it); the stored capture and grade stay as they are.
export async function recordRefreshFailure(db, url, reason, now = new Date(), { needsReview = false } = {}) {
  const prev = (await db.execute({ sql: "SELECT attempts FROM refresh_failures WHERE url = ?", args: [url] })).rows[0];
  const attempts = Number(prev?.attempts ?? 0) + 1;
  const backoff = {
    sql: `INSERT INTO refresh_failures (url, attempts, failed_at, retry_at, reason) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET attempts = excluded.attempts, failed_at = excluded.failed_at,
            retry_at = excluded.retry_at, reason = excluded.reason`,
    args: [url, attempts, now.getTime(), Date.parse(captureRetryAt(attempts, now)), String(reason ?? "").slice(0, 200)],
  };
  if (!needsReview) return void (await db.execute(backoff));
  await db.batch([backoff, { sql: "UPDATE portfolios SET needs_review = 1 WHERE url = ? AND COALESCE(needs_review, 0) != 1", args: [url] }], "write");
  // The review row; the backoff above is written either way, so a failure here is only logged.
  const why = String(reason ?? "").replace(/^(error|dead|parked|pending): /, "");
  await blockedRefreshReview(db, { url, reason: why, now }).catch((e) => console.warn(`  ${url}: review row not written (${String(e?.message ?? e).slice(0, 80)})`));
}

/** The one covered page besides the bot wall that sends a failed refresh to the owner: a dialog still on top. */
const COVERED = /^still a dialog on top\b/;

/**
 * Whether a failed refresh goes to the owner's review list (owner,
 * 2026-11-22: a re-capture that hits a bot check or a covering dialog goes
 * there): a bot or security check (BOT_WALL_REASON, from the screen or the
 * error status), or a dialog still covering the page after the capture tried
 * to close it. Not the other verdicts a first capture sends to review (a page
 * of only a canvas, video or image, an error status on a page that shows a
 * site), and not a gate, loader or mode picker still in the way: those stay
 * refresh failures, listed on the Capture problems page (group A) with their
 * reason. The narrow view never fails a capture (narrowView), so only the
 * desktop view's verdicts come here.
 * @param {{ reason?: string }} verdict
 */
export function refreshNeedsReview({ reason = "" } = {}) {
  const r = String(reason);
  if (isBotWallReason(r)) return true;
  return r.startsWith(BLOCKED_PREFIX) && COVERED.test(r.slice(BLOCKED_PREFIX.length));
}

/** The longest one site's capture may take, everything included; a normal one takes one to three minutes. */
export const SITE_LIMIT_MS = 5 * 60 * 1000;
/** The longest each write after a good capture may take (the row, the backoff, the old images), so a stalled request never hangs the run. */
export const STEP_LIMIT_MS = 30000;
/** How long closing a timed-out capture's browser context is waited for. */
const CLOSE_LIMIT_MS = 15000;
/**
 * captureSite's answer when the shared browser went away under the capture:
 * the site did nothing wrong, so nothing is recorded and the run puts it back
 * in line (captureQueue).
 */
export const BROWSER_GONE = "retry (the browser went away)";
/**
 * How long a capture waits for the browser's own word (its "disconnected"
 * event) once something says it may be gone: when Chromium dies, its pages
 * and context close first and the browser reports itself disconnected a
 * moment later, so the call that failed first cannot tell.
 */
const GONE_GRACE_MS = 5000;
/** How long the capture's page gets to answer a probe (lost()). */
const PROBE_MS = 2000;
/** Error text that suggests the browser went away: only a reason to wait for the browser's own word, never the answer. */
const CLOSED_TEXT = /has been closed|target closed|browser closed|disconnected|crashed|connection closed/i;

/**
 * Follows the shared browser for one capture: whether it went away, from its
 * own state (isConnected, its "disconnected" event) and not from whichever
 * call happened to fail. `ctxLost` marks that the capture's context closed
 * without the capture closing it.
 * @param {import("playwright").Browser} browser
 */
function watchBrowser(browser) {
  let resolveGone;
  const goneEvent = new Promise((r) => (resolveGone = r));
  const w = {
    gone: !browser.isConnected(),
    ctxLost: false,
    /** Whether the browser is gone now. */
    now: () => w.gone || !browser.isConnected(),
    /** The capture's page, once there is one: lost() asks it whether it still answers. */
    page: null,
    /** Set once the capture closes its own context. */
    closedByUs: false,
    /**
     * Whether the browser went away, after something went wrong. When Chromium
     * dies, the call that fails first (a navigation aborted, a wait on a page
     * being closed) does so while the browser still says it is connected. So
     * the capture's page is asked to answer (PROBE_MS): one that answers means
     * the browser is there. When it does not, or the context closed under the
     * capture, or the error text points that way, the browser gets
     * GONE_GRACE_MS to report itself disconnected.
     */
    async lost(err) {
      if (w.now()) return true;
      const hinted = w.ctxLost || CLOSED_TEXT.test(String(err?.message ?? err ?? ""));
      // No page yet (the database, the pre-check) and nothing pointing at the browser: it is still there.
      if (!hinted && !w.page) return false;
      // The capture closed its own context (a rejected capture, a storage error): its page is closed by design.
      if (!hinted && w.closedByUs) return w.now();
      if (!hinted && !w.page.isClosed()) {
        const answers = await within(w.page.evaluate(() => 1), PROBE_MS, "the page answering").then(
          () => true,
          () => false
        );
        if (answers && !w.ctxLost) return w.now();
      }
      let timer;
      await Promise.race([goneEvent, new Promise((r) => (timer = setTimeout(r, GONE_GRACE_MS)))]);
      clearTimeout(timer);
      return w.now();
    },
    stop: () => browser.off?.("disconnected", onGone),
  };
  const onGone = () => {
    w.gone = true;
    resolveGone();
  };
  browser.on?.("disconnected", onGone);
  return w;
}

/** `promise`, or a rejection naming `what` once `ms` have passed. */
function within(promise, ms, what) {
  let timer;
  const timedOut = () => Object.assign(new Error(`${what} took over ${Math.round(ms / 1000)}s`), { timedOut: true });
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(timedOut()), ms)))]).finally(() => clearTimeout(timer));
}

/** Closes a browser context, waiting at most CLOSE_LIMIT_MS (a hung page must not hang the close). */
const closeWithin = (ctx) => (ctx ? within(ctx.close(), CLOSE_LIMIT_MS, "closing the page").catch(() => {}) : Promise.resolve());

/**
 * Follows a page's main document: the status and cf-mitigated header of the
 * last response its own navigation got (a challenge that reloads into the
 * site ends on the site's response). { status: 0 } until there is one.
 * `arrived`: the latest navigation is over (documentArrived).
 * @param {import("playwright").Page} page
 */
function trackDocument(page) {
  const doc = { status: 0, cfMitigated: "", navigations: 0, arrived: true };
  const mainNavigation = (req) => {
    try {
      return req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {
      return false; // a request without a frame (a service worker's): not the document
    }
  };
  // The main document's requests not yet answered, and whether the latest one ended in a new document
  // (parsed) or in none (failed, or a 204 or 205, which keeps the page as it was).
  const inFlight = new Set();
  const settle = () => {
    if (inFlight.size === 0) doc.arrived = true;
  };
  // `navigations`: the main document's requests (the first load, a reload, the page sending the browser on).
  page.on("request", (req) => {
    if (!mainNavigation(req)) return;
    doc.navigations++;
    doc.arrived = false;
    inFlight.delete(req.redirectedFrom());
    inFlight.add(req);
  });
  page.on("response", (res) => {
    try {
      if (!mainNavigation(res.request())) return;
      doc.status = res.status();
      doc.cfMitigated = res.headers()["cf-mitigated"] ?? "";
      inFlight.delete(res.request());
      if (res.status() === 204 || res.status() === 205) settle();
    } catch {
      // a response without a frame (a service worker's): not the document
    }
  });
  page.on("requestfailed", (req) => {
    if (!inFlight.delete(req)) return;
    settle();
  });
  page.on("domcontentloaded", settle);
  return doc;
}

/**
 * Waits up to `ms` for the main document's latest navigation (a reload, the
 * page sending the browser on) to arrive: answered and, unless it failed or
 * had nothing to show, the new document parsed. Until then the page is still
 * the old document: its load state, its text and `doc.status` (the old
 * response's) say nothing about what the navigation brought, so an error
 * page judged then passes for the site and gets the waits and the
 * scroll-through. Returns whether it arrived.
 * @param {import("playwright").Page} page
 */
async function documentArrived(page, doc, ms = 30000) {
  const until = Date.now() + ms;
  while (!doc.arrived && Date.now() < until && !page.isClosed()) await page.waitForTimeout(100).catch(() => {});
  return doc.arrived;
}

/** How long a challenge-looking error page (isChallengeStatus) gets to reload into the site. */
export const CHALLENGE_WAIT_MS = 15000;

/**
 * Waits up to `ms` for the main document to answer below 400 again (a
 * non-interactive challenge that reloads into the site), then for it to
 * load. Returns whether it did.
 * @param {import("playwright").Page} page
 */
async function waitOutChallenge(page, doc, ms = CHALLENGE_WAIT_MS) {
  const until = Date.now() + ms;
  while (doc.status >= 400 && Date.now() < until) await page.waitForTimeout(500);
  if (doc.status >= 400) return false;
  // The answer is in, but the challenge page is the document until the site's is parsed.
  await documentArrived(page, doc);
  await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  return true;
}

/** The one-line result of a verdict or a blocked reason: "blocked (...)" for a blocked reason, else "<status> (<reason>)". */
const resultOf = (status, reason) =>
  String(reason).startsWith(BLOCKED_PREFIX) ? `blocked (${String(reason).slice(BLOCKED_PREFIX.length)})` : `${status} (${reason})`;

const wordCount = (t) => String(t ?? "").split(/\s+/).filter(Boolean).length;

// The tall image of one view with the page shown as a visitor sees it again afterwards (pipeline/fullpage.mjs).
export { captureViewAsSeen };

/**
 * Whether the desktop view, after its passes, waits and scroll-through, is
 * not the site. `seenText` is the page's text as a visitor sees it after the
 * scroll-through (captureViewAsSeen), the text that is stored: it is the text
 * judged. Returns { verdict, shown }: `shown` is what was judged
 * (./capture-blocked.mjs readBlockedInputs), `verdict` null or { status,
 * reason, needsReview }. In order: the main
 * document's HTTP status (httpVerdict), a parking page where the browser
 * ended up (./gate.mjs parkedPage on the page's address, its rendered HTML
 * `seenHtml`, text and title, as the plain pre-check reads the served one), then
 * capturedBlocked. A page with no words, or only a canvas, video or image
 * (MEDIA_ONLY), is never stored as live: a flat frame is blocked as blank,
 * anything else goes to the owner's review (MEDIA_REVIEW_REASON).
 * @param {import("playwright").Page} page
 */
async function judgeDesktop(page, doc, passes, seenText, seenHtml = "") {
  const shown = await readBlockedInputs(page, seenText, seenText);
  const verdict = httpVerdict({ status: doc.status, cfMitigated: doc.cfMitigated, text: shown.text, title: shown.title, shown: { ...shown, ...passes } });
  if (verdict) return { verdict, shown };
  // A parking page where the browser ended up, after the page's own redirects (./gate.mjs parkedPage).
  const parked = parkedPage({ finalUrl: page.url(), html: seenHtml, text: shown.text, title: shown.title });
  if (parked) return { verdict: { status: "parked", reason: parked, needsReview: false }, shown };
  const blocked = capturedBlocked({ ...shown, ...passes });
  if (blocked === MEDIA_ONLY || (blocked === null && wordCount(shown.text) === 0)) {
    const frame = await shot(page, { type: "png" }).catch(() => null);
    if (frame && flatFrame(frame)) return { verdict: { status: "error", reason: `${BLOCKED_PREFIX}${BLANK_FRAME}`, needsReview: false }, shown };
    return { verdict: { status: "error", reason: MEDIA_REVIEW_REASON, needsReview: true }, shown };
  }
  if (blocked) return { verdict: { status: "error", reason: `${BLOCKED_PREFIX}${blocked}`, needsReview: blocked === BOT_WALL }, shown };
  return { verdict: null, shown };
}

/**
 * The narrow view, once the desktop view showed the site: whether its screen
 * is the site. An error status (the page reloaded itself into one) or a bot
 * check makes the narrow view `missing`, with the reason; anything else the
 * blocked rules find (a "best viewed on a desktop" screen, a cookie dialog
 * that would not close) is a `note` for the meta. Neither ever fails the
 * capture: the desktop view decides.
 * @param {import("playwright").Page} page
 */
async function judgeNarrow(page, doc, passes) {
  const shown = await readBlockedInputs(page);
  const verdict = httpVerdict({ status: doc.status, cfMitigated: doc.cfMitigated, text: shown.text, title: shown.title, shown: { ...shown, ...passes } });
  const plain = (reason) => (String(reason).startsWith(BLOCKED_PREFIX) ? String(reason).slice(BLOCKED_PREFIX.length) : String(reason));
  if (verdict) return { missing: plain(verdict.reason), note: null };
  if (isBotWallPage(shown)) return { missing: BOT_WALL, note: null };
  return { missing: null, note: capturedBlocked({ ...shown, ...passes }) };
}

/** The narrow view's viewport (pipeline/fullpage.mjs FRAMES.phone), and the desktop's it goes back to. */
const NARROW = { width: FRAMES.phone.width, height: FRAMES.phone.viewportHeight };
const WIDE = { width: FRAMES.desktop.width, height: FRAMES.desktop.viewportHeight };
/** How long the resized page gets for what its new width asks for (srcset images, a script a media query loads). */
const REFLOW_IDLE_MS = 3000;
/** In the browser: two frames, so the page is laid out and painted at its new size (a timer in case frames never come). */
const NEXT_PAINT = () =>
  new Promise((done) => {
    setTimeout(done, 500);
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });

/**
 * The narrow view (390 x 844) of the page the desktop view showed, without
 * a second visit: the same page is resized, given a moment to reflow and
 * settle, passed through the gate, the dialog and the mode picker if the
 * narrow layout shows one, then measured (sideways overflow), photographed
 * (the tall phone image) and read (the facts some sites show only at 390
 * wide). A second visit seconds after the first, from a data-centre address,
 * is what many sites' protection challenges (Cloudflare answered 28 of 30
 * such failures, 2026-11-23); a fresh load at 390 showed the same links,
 * words and overflow as the resized page on every one of 15 sampled sites.
 *
 * Never fails the capture. Returns { view, crop, seen, overflow390, passes,
 * note, missing, navigated }: `missing` is the reason there is no narrow
 * view (the page reloaded itself into a bot check or an error status, or
 * could not be resized or photographed), and then `view` is a failed view
 * and `crop`, `seen` and `overflow390` are null. `overflow390` is also null
 * when the page kept the desktop's width (`widthNote` says so).
 * `navigated`: the page made a new document load meanwhile (a site that
 * reloads when the window narrows), so it is no longer the page the desktop
 * view read; `endUrl` is where it ended.
 * @param {import("playwright").Page} page
 */
export async function narrowView(page, doc) {
  const before = doc.navigations;
  const startUrl = page.url();
  const navigated = () => doc.navigations > before;
  let passes = { splash: null, modal: null, mode: null };
  const done = (fields) => ({ crop: null, seen: null, overflow390: null, widthNote: null, passes, note: null, missing: null, firstScreen: null, navigated: navigated(), endUrl: page.url(), ...fields });
  const missing = (reason) => done({ view: { ok: false, meta: { missing: reason } }, missing: reason });
  try {
    await page.setViewportSize(NARROW);
  } catch {
    return missing("the page could not be resized");
  }
  await page.evaluate(NEXT_PAINT).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: REFLOW_IDLE_MS }).catch(() => {});
  // A page that loads itself again at the new width (at once, or from a resize handler that waits a
  // moment): judged like a new visit before the waits. Asked again after the passes and the settle,
  // so a late reload is seen before the image is taken (at most twice: a page that keeps reloading
  // is photographed as it then is).
  let handled = before;
  for (let round = 0; round < 2 && doc.navigations > handled; round++) {
    handled = doc.navigations;
    await documentArrived(page, doc);
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    if (doc.status >= 400) {
      const early = await judgeNarrow(page, doc, passes);
      if (early.missing) return missing(early.missing);
    }
    await waitForContent(page);
  }
  const arrive = async () => {
    // A gate, a dialog or a picker the narrow layout shows (the desktop's were passed already).
    passes = {
      splash: await passSplashGate(page).catch(() => null),
      modal: await passModal(page).catch(() => null),
      mode: await passModePicker(page).catch(() => null),
    };
    // Transitions and images the new width started: a short wait for a still first screen.
    await settleFirstScreen(page, { polls: 4, diff: pngDiff }).catch(() => false);
  };
  await arrive();
  if (doc.navigations > handled) {
    // A late reload (a debounced resize handler): the new load is judged and settled before the image.
    await documentArrived(page, doc);
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    if (doc.status >= 400) {
      const early = await judgeNarrow(page, doc, passes);
      if (early.missing) return missing(early.missing);
    }
    await waitForContent(page);
    await arrive();
  }
  // A page that went to another site when the window narrowed is not this site's phone view.
  if (navigated() && !sameSite(startUrl, page.url())) return missing(`the page went to ${hostOf(page.url()) || "another address"} when the window narrowed`);
  // Sideways scrolling: the page is wider than the screen (5 px of slack, as before). A page still
  // about as wide as the desktop window (WIDE_KEPT_PX) kept a width set once at load (a canvas sized
  // from window.innerWidth): what a phone would see is unknown, so it is not called an overflow.
  const width = await page.evaluate(() => document.documentElement.scrollWidth).catch(() => null);
  const keptWide = typeof width === "number" && width >= WIDE_KEPT_PX;
  const overflow390 = typeof width !== "number" || keptWide ? null : width > NARROW.width + 5;
  const widthNote = keptWide ? `${width}px wide at 390: a width set once at load, so whether it fits a phone is unknown` : null;
  // The settled phone screen, before the scroll-through: what the mobile five-second reading is compared with.
  const firstScreen = await readNow(page, Date.now()).then((r) => r.raw ?? null);
  const view = await captureViewAsSeen(page, "phone");
  const judged = await judgeNarrow(page, doc, passes);
  if (judged.missing) return missing(judged.missing);
  const crop = view.ok ? view.files.crop : await shot(page, { type: "jpeg", quality: 75 }).catch(() => null);
  if (!crop) return missing(view.meta?.error ? `no phone image (${view.meta.error})` : "no phone image");
  // A narrow view that is blocked (the note) or cannot be read adds nothing to the facts.
  const read = judged.note ? null : await page.evaluate(readRenderedPage).catch(() => null);
  const seen = read ? { html: read.html, text: read.text, finalUrl: page.url() } : null;
  return done({ view, crop, seen, overflow390, widthNote, note: judged.note, firstScreen: judged.note ? null : firstScreen });
}

/** A page this wide at 390 kept the desktop window's width (1440): an element sized once at load, not a phone layout. */
const WIDE_KEPT_PX = 1400;

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
const sameSite = (a, b) => hostOf(a) !== "" && hostOf(a) === hostOf(b);

/**
 * Captures one site into `root`/captures/<key>/ and its `portfolios` row.
 * `db`: the pipeline database; `s3`: an R2 client or null (local only);
 * `limitMs`: the most the whole capture may take (SITE_LIMIT_MS): past it the
 * site's browser context is closed and a failed capture recorded;
 * `stepLimitMs`: the most each write after a good capture may take.
 * Returns a one-line result; "live" first when the capture was stored, and
 * BROWSER_GONE when the browser went away under it (nothing recorded).
 */
export async function captureSite(browser, entry, { refresh = false, db, s3 = null, root = ROOT, limitMs = SITE_LIMIT_MS, stepLimitMs = STEP_LIMIT_MS } = {}) {
  const { url, name } = entry;
  // A refresh never marks a site failed (see the header): it only waits out a
  // backoff, and a bot check or a covering dialog also goes to the owner's
  // review list (refreshNeedsReview).
  const record = refresh
    ? (status, reason) => recordRefreshFailure(db, url, `${status}: ${reason}`, new Date(), { needsReview: refreshNeedsReview({ reason }) })
    : (status, reason, opts = {}) => recordCaptureFailure(db, url, name, status, reason, { needsReview: Boolean(opts.needsReview) });
  // run.aborted: the time limit passed, so the capture must write nothing more;
  // run.committed: the good capture is being written (each write bounded), so the limit waits for it;
  // run.storedGood: the site has a good capture, which a failed one never marks failed.
  // run.watch: whether the shared browser went away under this capture (watchBrowser).
  const run = { aborted: false, committed: false, storedGood: false, ctx: null, watch: watchBrowser(browser) };
  const keepsGood = () => run.storedGood && !refresh;
  const fail = async (...a) => {
    if (!run.aborted && !keepsGood() && !run.watch.now()) await record(...a);
  };
  const TIMED_OUT = Symbol("timed out");
  // When the limit passes: the cookie check keeps clear of it (./cookie-check.mjs readCookieCheck).
  run.deadline = Date.now() + limitMs;
  let timer;
  const work = captureOnce(browser, entry, { refresh, db, s3, root, fail, stepLimitMs }, run);
  work.then(run.watch.stop, run.watch.stop);
  try {
    const out = await Promise.race([work, new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), limitMs)))]);
    if (out !== TIMED_OUT) return out;
  } catch (e) {
    // Thrown before captureOnce's own handling (the database, a new context): its page goes too.
    if (await run.watch.lost(e)) return BROWSER_GONE;
    await closeWithin(run.ctx);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (run.committed) return work.catch((e) => `error (${String(e?.message ?? e).slice(0, 80)})`);
  run.aborted = true;
  work.catch(() => {});
  if (await run.watch.lost()) return BROWSER_GONE;
  // Closing the context kills the page, also one whose main thread never returns.
  await closeWithin(run.ctx);
  if (run.watch.now()) return BROWSER_GONE;
  const reason = `capture timed out after ${Math.round(limitMs / 1000)}s`;
  if (keepsGood()) return `error (${reason}); the existing capture is kept`;
  await record("error", reason);
  return `error (${reason})`;
}

/** captureSite's work, without the time limit; `fail` records a failed capture, `run` is the limit's state. */
async function captureOnce(browser, entry, { refresh, db, s3, root, fail, stepLimitMs }, run) {
  const { url, name } = entry;
  const key = keyOf(url);
  const dir = path.join(root, "captures", key);
  const IMAGES_BUCKET = imagesBucket();

  // The stored images, to keep them when the page looks the same, and
  // whether the site already has a good capture (a failed one, the
  // pre-check's included, never replaces it or marks it failed).
  const stored = await storedCapture(db, url);
  const prevFullPage = stored.fullPage;
  run.storedGood = stored.good;
  const kept = (result) => (refresh || stored.good ? `${result}; the existing capture is kept` : result);

  const gate = await httpGate(url);
  // A 401/403/429/503 or a TLS failure on the plain request is often a bot filter or a
  // certificate a browser accepts: the browser decides (./capture-steps.mjs), and the
  // status its main document ends on decides again below (httpVerdict).
  if (gate.status !== "live" && !inconclusiveGate(gate)) {
    // The browser went away meanwhile: the run puts the site back in line, nothing is recorded.
    if (run.watch.now()) return BROWSER_GONE;
    await fail(gate.status, gate.reason);
    return kept(`${gate.status} (${gate.reason})`);
  }

  const ctx = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    userAgent: UA,
    ignoreHTTPSErrors: true,
  });
  run.ctx = ctx;
  // The context closing without this capture closing it: the browser may be going away.
  let closing = false;
  ctx.on("close", () => {
    if (!closing) run.watch.ctxLost = true;
  });
  const closeOwn = () => {
    closing = true;
    run.watch.closedByUs = true;
    return closeWithin(ctx);
  };
  if (run.aborted) {
    await closeOwn();
    return "aborted";
  }

  // A capture that is not the site: nothing of it is stored. A site with a
  // good capture keeps it (a refresh only waits out its backoff); one
  // without is a failed capture with its reason, retried later with backoff.
  // A verdict reached while the browser was dying (a page that read as
  // blank because it was closing) is not the site's: nothing is recorded.
  const reject = async ({ status, reason, needsReview = false }) => {
    if (await run.watch.lost()) return BROWSER_GONE;
    await closeOwn();
    if (run.watch.now()) return BROWSER_GONE;
    await fail(status, reason, { needsReview });
    return kept(resultOf(status, reason));
  };

  const page = await ctx.newPage();
  run.watch.page = page;
  const doc = trackDocument(page);
  // Every request from the first one, for the cookie check (./cookie-check.mjs) read on arrival.
  const cookieWatch = watchRequests(page);
  let cookieReading = null;

  const consoleErrors = [];
  let bytes = 0,
    requests = 0,
    broken = 0;
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("requestfinished", async (req) => {
    requests++;
    try {
      const sz = await req.sizes();
      bytes += sz.responseBodySize + sz.responseHeadersSize;
    } catch {}
  });
  page.on("response", (res) => {
    if (res.status() === 404) broken++;
  });

  // The image version this capture uploaded, if any (removed again when the capture is not stored).
  let uploadedV = null;
  // The desktop's first five seconds (./first-five.mjs): the screen read five seconds after the
  // navigation starts, on this visit; nothing is pressed or closed before it (arrive waits for it).
  const startedAt = Date.now();
  const desktopAt5 = readAtFive(page, startedAt).then((r) => ({ ...r, status: doc.status, cfMitigated: doc.cfMitigated }));
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    /** The settle, the passes and the wait for content, on the page as it now is. */
    const arrive = async () => {
      // Let SPAs/preloaders settle: idle network if it comes, then a beat.
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      // The five-second reading is of the page as it came, before the capture presses anything.
      await desktopAt5;
      // The cookie check, on the settled page before anything below clicks or
      // dismisses: tracking cookies, tracker requests and a consent banner
      // (./cookie-check.mjs). After a challenge that reloads into the site, the
      // site's own arrival is the one kept. Bounded, and clear of the capture's
      // own time limit; it never throws.
      cookieReading = await readCookieCheck(page, cookieWatch, { deadline: run.deadline });
      // A splash gate ("CLICK TO CONTINUE", "Press any key", a loader at
      // 100%) is clicked through first, at most twice (./splash.mjs), so the
      // capture and the grade see the portfolio, not the gate.
      const splash = await passSplashGate(page).catch(() => null);
      // A dialog on top of the page ("Choose a Theme", a welcome modal) is
      // closed the way a visitor would (./splash.mjs passModal), so the
      // capture shows the site's default view.
      const modal = await passModal(page).catch(() => null);
      // A mode picker ("Recruiter / Developer", "Dark / Light", "2D / 3D") gets
      // its plainest option clicked (./splash.mjs passModePicker).
      const mode = await passModePicker(page).catch(() => null);
      // Blank-page gate: visible text, or visual content (canvas apps such as
      // Flutter web have no text in the DOM), given up to 15 seconds to appear
      // (slow single-page apps render nothing at first; ./capture-steps.mjs).
      await waitForContent(page);
      return { splash, modal, mode, rendered: await page.evaluate(readRenderedPage) };
    };
    let { splash, modal, mode, rendered } = await arrive();
    // An error page is decided here, before the waits, frames, link checks
    // and scroll-through below: none of them can change what its status says,
    // and a host that just answered 429 should not be asked for more. A
    // challenge-looking one (the pages the pre-check hands to the browser)
    // first gets up to CHALLENGE_WAIT_MS to reload into the site.
    if (doc.status >= 400) {
      let first = await readBlockedInputs(page, rendered.text);
      const look = { status: doc.status, cfMitigated: doc.cfMitigated, text: first.text, title: first.title, shown: { ...first, splash, modal, mode } };
      if (isChallengeStatus(look) && (await waitOutChallenge(page, doc))) {
        ({ splash, modal, mode, rendered } = await arrive());
        first = await readBlockedInputs(page, rendered.text);
      }
      const verdict = httpVerdict({ status: doc.status, cfMitigated: doc.cfMitigated, text: first.text, title: first.title, shown: { ...first, splash, modal, mode } });
      if (verdict) return reject(verdict);
    }
    // The cookie check has its last reading (a challenge's reload included): its listener stops.
    cookieWatch.stop();
    if (rendered.text.trim().length < 30 && !rendered.media) return reject({ status: "dead", reason: "renders blank" });

    // Wait out slow preloaders and intro animations: poll until both the
    // viewport and its center (spinners, percent counters) hold still for
    // two polls. Pages that churn the whole viewport every poll are
    // animated backgrounds, not loaders - bail early and call it motion.
    let prevShot = await shot(page, { type: "png" });
    let quiet = 0,
      lively = 0,
      polls = 0;
    while (polls < 8 && quiet < 2 && lively < 2) {
      await page.waitForTimeout(3000);
      const cur = await shot(page, { type: "png" });
      const full = pngDiff(prevShot, cur);
      if (full < 0.01 && pngDiff(prevShot, cur, true) < 0.005) quiet++;
      else quiet = 0;
      lively = full > 0.05 ? lively + 1 : 0;
      prevShot = cur;
      polls++;
    }
    const heroSettled = quiet >= 2;

    // Motion: two frames 3 seconds apart, diffed in memory. The AI grade gets
    // the result as a fact, not the frames. The hero is cut from the tall
    // image below (its first screenful, after the scroll-through).
    const f0 = await shot(page, { type: "png" });
    await page.waitForTimeout(3000);
    const f2 = await shot(page, { type: "png" });
    const motion = lively >= 2 || pngDiff(f0, f2) > 0.02;

    // Dark-mode support: pixel-diff light vs dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    const dark = await shot(page, { type: "png" });
    const darkMode = pngDiff(f2, dark) > 0.05;
    await page.emulateMedia({ colorScheme: "light" });

    // DOM-shape hash + class signature (originality clustering input).
    const domSig = await page.evaluate(() => {
      const tags = [];
      const walk = (el, depth) => {
        if (depth > 12 || tags.length > 3000) return;
        tags.push(el.tagName);
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(document.body, 0);
      const classes = new Set();
      for (const el of document.querySelectorAll("[class]"))
        for (const c of el.classList) classes.add(c);
      return {
        tags: tags.join(","),
        classes: [...classes].sort().slice(0, 500).join(","),
      };
    });
    const domHash = createHash("sha1").update(domSig.tags).digest("hex");
    const classHash = createHash("sha1").update(domSig.classes).digest("hex");

    // The diagnostics as they stand now: the scroll-through below loads
    // lazy content, which must not change the page weight or the errors.
    const diagnostics = {
      consoleErrors: consoleErrors.length,
      consoleSample: consoleErrors.slice(0, 5),
      requests,
      bytes,
      broken404s: broken,
    };
    // The page before the scroll-through, in case it cannot be read after it.
    const settled = await page.evaluate(readRenderedPage).catch(() => rendered);
    // The settled first screen, which the five-second reading is compared with (./first-five.mjs introAt5).
    const desktopLater = await readNow(page, startedAt);

    // The tall desktop image: scroll through once, back to the top, stitch
    // (pipeline/fullpage.mjs). Its first screenful is the grade's hero.jpg;
    // if the stitch fails, a plain screenshot of the top stands in. The
    // fixed and sticky bars the stitching hides are shown again afterwards.
    const desktopView = await captureViewAsSeen(page, "desktop");

    // One reading of the page as a visitor sees it, after the scroll-through
    // (lazy content loaded, fixed bars shown): it is judged, stored as the
    // page text, and measured for the facts, so the three never disagree.
    const seen = await page.evaluate(readRenderedPage).catch(() => settled);

    // Not the site (judgeDesktop): an error status, a parked domain, or a
    // screen that after the passes, the waits and the scroll-through is
    // still blocked (./capture-blocked.mjs). Nothing of it is stored,
    // uploaded or graded (reject). A bot wall is not called broken: it is
    // marked for the owner's review.
    const desktop = await judgeDesktop(page, doc, { splash, modal, mode }, seen.text, seen.html);
    if (desktop.verdict) return reject(desktop.verdict);
    const pageText = normalizePageText(seen.text);
    const heroJpg = desktopView.ok ? desktopView.files.crop : await shot(page, { type: "jpeg", quality: 75 });

    // Where the desktop view ended up, before the narrow view may move the page on.
    const homeUrl = page.url();

    // The narrow view: the same page resized to 390 x 844, never a second
    // visit (narrowView): overflow check, the tall phone image (its top is
    // mobile.jpg) and the phone reading. The desktop view decides: a narrow
    // view that is not the site is recorded as missing (phoneMissing), and a
    // blocked one as a note (phoneBlocked); neither fails the capture.
    const narrow = await narrowView(page, doc);
    const phoneView = narrow.view;
    const { splash: mobileSplash, modal: mobileModal, mode: mobileMode } = narrow.passes;
    // Without a phone image no mobile.jpg is written: the pages read
    // meta.phoneMissing (lib/shots.ts shotBases) and show hero.jpg on a phone
    // instead, never a desktop crop passed off as a phone view.
    const mobileJpg = narrow.crop;
    // Back to the desktop's size for the projects page below, which may press a link on this page;
    // not on a page that loaded itself again (a resize could reload it once more).
    if (!narrow.navigated) {
      await page.setViewportSize(WIDE).catch(() => {});
      await page.evaluate(NEXT_PAINT).catch(() => {});
    }
    // Facts from the desktop reading (single-page apps included), merged with
    // the narrow view's own reading (projects some sites show only at 390 wide),
    // plus a capped check of their project and demo links. A narrow view that
    // is missing, blocked or cannot be read adds nothing: the desktop facts stand.
    // When the home page shows fewer than 3 projects, the site's own projects page
    // is read (./capture-projects.mjs: a plain GET of a same-site link,
    // time-limited; a failure adds nothing).
    const home = { html: seen.html, text: seen.text, url, finalUrl: homeUrl, phone: narrow.seen };
    const projectsUrl = projectsPageFor(homeProjectLinks(home), homeUrl);
    // The step reads from this page's site; a page the phone view left on another site is not used, and the meta says so.
    const pageOnSite = sameSite(homeUrl, page.url());
    const projectsSkipped = projectsUrl && !pageOnSite ? `the page was on ${hostOf(page.url()) || "another address"} after the phone view` : null;
    const projectsPage = projectsUrl && pageOnSite ? await readProjectsPage(page, projectsUrl).catch(() => null) : null;
    // homeText: the page text as stored, which the nightly link re-check compares own project pages against too.
    const facts = await measurePage({ ...home, name, motion, source: "rendered", projectsPage, homeText: pageText }, { userAgent: UA }).catch(() => null);
    // The cookie check read on arrival, stored with the facts under its region, beside the readings
    // other regions made (./cookie-check.mjs withReading). Facts from before it have no `privacy`: not measured.
    if (facts && cookieReading) facts.privacy = withReading(storedPrivacy(stored.facts), cookieReading);

    // A browser that died while the views were taken leaves them half made (their own errors are caught): not stored.
    if (await run.watch.lost()) return BROWSER_GONE;
    await closeOwn();
    if (run.aborted) return "aborted";
    // The first five seconds (./first-five.mjs): the desktop's from this visit, the phone's from a
    // throttled visit of its own, made now that this one is over, so a site that challenges a repeat
    // visit loses only this reading. Bounded, and skipped near the time limit; it never throws.
    if (facts) {
      const mobile =
        run.deadline - Date.now() < MOBILE_MIN_LEFT_MS
          ? { error: "too little of the capture's time was left" }
          : await readMobileFirstFive(browser, url, { name, userAgent: UA });
      facts.first_five = withFirstFive(
        storedFirstFive(stored.facts),
        firstFiveOf({ desktopAt5: await desktopAt5, desktopLater, phoneLater: narrow.firstScreen, mobile, name, viewport: DESKTOP_VIEWPORT })
      );
    }
    if (run.aborted) return "aborted";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hero.jpg"), heroJpg);
    // An older capture's mobile.jpg left in this folder is not this capture's phone view: it is not uploaded again.
    if (mobileJpg) fs.writeFileSync(path.join(dir, "mobile.jpg"), mobileJpg);
    else fs.rmSync(path.join(dir, "mobile.jpg"), { force: true });

    // The stored images: a new version, or nothing when the page looks as it
    // did (pipeline/fullpage.mjs unchanged), so no write and every cached
    // copy stays good. They go to the public images bucket only
    // (R2_IMAGES_BUCKET, pipeline/shot-store.mjs); without it nothing is
    // stored and the version is not recorded, so the backfill makes them
    // once the bucket exists.
    const next = nextFullPage(prevFullPage, { desktopView, phoneView, pageText, at: new Date() });
    const { uploadImages, uploadLegacy } = next;
    const fullPage = uploadImages && !(s3 && IMAGES_BUCKET) ? notStored(next.fullPage) : next.fullPage;
    // The new version goes up first; the old one is deleted only once the
    // row points at the new one (below), so the row never names images that
    // are gone.
    if (s3 && IMAGES_BUCKET && uploadImages && fullPageStorable(fullPage)) {
      const commands = await import("@aws-sdk/client-s3");
      if (run.aborted) return "aborted";
      // Set before the upload: a version partly up when a PUT fails is removed too (below).
      uploadedV = fullPage.v;
      await storeVersion({
        send: (c) => s3.send(c),
        commands,
        bucket: IMAGES_BUCKET,
        shotKey: key,
        v: fullPage.v,
        files: versionFiles(desktopView, phoneView),
      });
    }

    const meta = {
      ...diagnostics,
      // null (unknown) when there is no narrow view (phoneMissing) or the page kept a width set once at load (overflowUnknown).
      overflow390: narrow.overflow390,
      ...(narrow.widthNote ? { overflowUnknown: narrow.widthNote } : {}),
      darkMode,
      motion,
      heroSettled,
      domHash,
      classHash,
      // The splash gate passed on the way in (./splash.mjs), when there was one.
      ...(splash ? { splash: { ...splash, mobile: mobileSplash ? mobileSplash.passed : null } } : {}),
      // The dialog closed on the way in (./splash.mjs passModal), when there was one.
      ...(modal || mobileModal ? { modal: { ...(modal ?? {}), mobile: mobileModal ? mobileModal.passed : null } } : {}),
      // The mode picked on the way in (./splash.mjs passModePicker), when a picker was shown.
      ...(mode || mobileMode ? { mode: { ...(mode ?? {}), mobile: mobileMode ? mobileMode.passed : null } } : {}),
      // One line of what was done to reach the screenshots; only the screen after it is stored.
      ...(actionNote({ splash, modal, mode }) ? { action: actionNote({ splash, modal, mode }) } : {}),
      // What the blocked rules found on the narrow view, when its screen is not the site (judgeNarrow).
      ...(narrow.note ? { phoneBlocked: narrow.note } : {}),
      // Why there is no narrow view, when there is none (narrowView): the desktop capture is stored without it.
      ...(narrow.missing ? { phoneMissing: narrow.missing } : {}),
      // The page loaded itself again when narrowed, and where it ended; the projects page step was then not read from it when it was off the site.
      ...(narrow.navigated ? { phoneReloaded: narrow.endUrl } : {}),
      ...(projectsSkipped ? { projectsPageSkipped: projectsSkipped } : {}),
      fullPage,
    };

    // The old frames, cut from the tall images, while the site still reads
    // them; not when nothing changed.
    if (legacyFramesOn() && uploadLegacy) await uploadDir(s3, key, dir);

    if (run.aborted) throw new Error("aborted");
    run.committed = true;
    const write = db.execute({
      sql: `INSERT INTO portfolios
              (url, name, status, reason, shot_key, meta, checked_at, captured_at,
               page_text, facts, facts_at)
            VALUES (?, ?, 'live', '', ?, ?, datetime('now'), datetime('now'), ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET status='live', reason='',
              shot_key=excluded.shot_key, meta=excluded.meta,
              checked_at=excluded.checked_at, captured_at=excluded.captured_at,
              capture_attempts=0, retry_at=NULL,
              page_text=excluded.page_text,
              facts=COALESCE(excluded.facts, portfolios.facts),
              facts_at=COALESCE(excluded.facts_at, portfolios.facts_at)`,
      args: [url, name, key, JSON.stringify(meta), pageText, facts ? JSON.stringify(facts) : null, facts?.measured_at ?? null],
    });
    // Bounded: a stalled database request must not hang the run. Only a
    // timeout is ambiguous (the row may or may not be written), so nothing
    // else is recorded and the new images stay (the row may point at them).
    // A write the database rejected is a failed capture like any other: the
    // catch below removes the new images and records it.
    try {
      await within(write, stepLimitMs, "storing the capture");
    } catch (e) {
      if (e?.timedOut) return `error (${String(e?.message ?? e).slice(0, 80)}; not recorded)`;
      throw e;
    }
    // Stored: a refresh backoff ends, and the old images go now that nothing points at them.
    // Neither can undo the capture, and each is bounded: a failure here is only logged.
    const warn = (what) => (e) => console.warn(`  ${url}: ${what} (${String(e?.message ?? e).slice(0, 80)})`);
    await within(db.execute({ sql: "DELETE FROM refresh_failures WHERE url = ?", args: [url] }), stepLimitMs, "clearing the refresh backoff").catch(warn("refresh backoff not cleared"));
    // A blocked re-capture's row on the owner's review list closes: this one got through (lib/reviews/door.mjs).
    if (stored.good) {
      await within(closeBlockedRefreshReviews(db, url), stepLimitMs, "closing the blocked re-capture's review row").catch(warn("blocked re-capture's review row not closed"));
    }
    // A capture that replaced a good one: whether it lost a portfolio sign or most of the text
    // (lib/capture-problems.mjs, the admin's Capture problems page). Facts the capture could not
    // measure keep the old ones (the write's COALESCE), so they are compared as kept.
    if (stored.good) {
      await within(
        recordCaptureChange(db, { url, prev: { facts: stored.facts, chars: stored.chars }, next: { facts: facts ?? stored.facts, chars: pageText.length }, capturedAt: sqliteNow() }),
        stepLimitMs,
        "recording what the new capture changed"
      ).catch(warn("capture change not recorded"));
    }
    if (uploadedV && prevFullPage?.v && prevFullPage.v !== uploadedV) {
      const commands = await import("@aws-sdk/client-s3");
      await within(deleteVersion({ send: (c) => s3.send(c), commands, bucket: IMAGES_BUCKET, shotKey: key, v: prevFullPage.v }), stepLimitMs, "deleting the old images").catch(
        warn(`old images ${key}/${prevFullPage.v} not deleted`)
      );
    }
    // Measured: its Starting rank from the code checks now, before Gemini (lib/tiers-store.mjs rankFromCode).
    if (facts) await within(rankFromCode(db, url), stepLimitMs, "setting the Starting rank").catch(warn("Starting rank not set"));
    return `live → ${key} (motion=${meta.motion} dark=${meta.darkMode} overflow=${meta.overflow390})`;
  } catch (e) {
    // Decided from the browser's own state, before this capture closes anything (watchBrowser).
    const gone = await run.watch.lost(e);
    await closeOwn();
    // A new version uploaded (or partly uploaded) for a capture that was not stored is nobody's: remove it.
    if (uploadedV && uploadedV !== prevFullPage?.v) {
      const commands = await import("@aws-sdk/client-s3").catch(() => null);
      if (commands) await within(deleteVersion({ send: (c) => s3.send(c), commands, bucket: IMAGES_BUCKET, shotKey: key, v: uploadedV }), stepLimitMs, "removing the new images").catch(() => {});
    }
    if (run.aborted) return "aborted";
    if (gone || run.watch.now()) return BROWSER_GONE;
    // A fault of the run, not of this site (the storage's credentials): it ends the run (captureQueue).
    if (isRunFault(e)) throw e;
    await fail("error", String(e.message ?? e).slice(0, 200));
    return kept(`error (${String(e.message ?? e).slice(0, 80)})`);
  }
}

/** Storage errors that no site causes: wrong or expired credentials, a missing bucket. */
const STORAGE_FAULT = /^(InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|NoSuchBucket|InvalidToken|ExpiredToken|Unauthorized|Forbidden|CredentialsProviderError)$/;

/**
 * Whether an error is a fault of the run rather than of one site: the
 * storage refusing this run's credentials or missing its bucket. captureSite
 * throws it instead of recording a failed capture, and captureQueue ends the
 * run with it (the database's own errors already throw: recording needs it).
 */
export function isRunFault(e) {
  const code = String(e?.Code ?? e?.code ?? e?.name ?? "");
  const http = Number(e?.$metadata?.httpStatusCode ?? 0);
  return STORAGE_FAULT.test(code) || http === 401 || http === 403;
}

// ---------------------------------------------------------------------------
// Main (only when run as a script: the tests import captureSite)
// ---------------------------------------------------------------------------
async function main() {
  // env (.env.local, no dotenv dependency). Optional: in CI (GitHub Actions)
  // there's no .env.local - the vars come straight from the runner env/secrets.
  if (fs.existsSync(path.join(ROOT, ".env.local"))) {
    for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }

  // CLI
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const LIMIT = Number(flag("limit", "0")) || Infinity;
  const CONCURRENCY = Number(flag("concurrency", "3"));
  const ONLY = flag("only", "");
  const FORCE = args.includes("--force");
  const REFRESH = Number(flag("refresh", "0")) || 0;
  // --recapture <file>: re-capture exactly the listed addresses in the file (one
  // a line), as a refresh: a failure keeps the old capture and marks nothing
  // but its refresh backoff (scripts/regrade-not-portfolio.mjs).
  const RECAPTURE = flag("recapture", "");

  // DB + R2 (the freshness tables hold the refresh backoff, lib/freshness.mjs)
  const db = pipelineDb(ROOT);
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  // What a re-capture made worse (lib/capture-problems.mjs).
  await ensureCaptureProblemSchema(db);

  let s3 = null;
  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  if (args.includes("--upload-only")) {
    if (!s3) {
      console.error("R2_* env vars missing - nothing to upload to.");
      process.exit(1);
    }
    const capDir = path.join(ROOT, "captures");
    const keys = fs.existsSync(capDir) ? fs.readdirSync(capDir) : [];
    for (const [i, key] of keys.entries()) {
      await uploadDir(s3, key, path.join(capDir, key));
      console.log(`[${i + 1}/${keys.length}] uploaded ${key}`);
    }
    process.exit(0);
  }

  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
  // Rows that left the list are marked delisted; the queue only holds roster sites.
  const roster = await syncRoster(db, feed);
  console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
  let queue = feed.filter((p) => !ONLY || p.url.includes(ONLY));
  if (RECAPTURE) {
    const want = new Set(fs.readFileSync(RECAPTURE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    queue = feed.filter((p) => want.has(p.url)).map((p) => ({ ...p, refresh: true }));
  }

  if (!FORCE && !RECAPTURE) {
    queue = await dueForCapture(db, queue);
  }
  queue = queue.slice(0, LIMIT);
  // The nightly refresh: listed, healthy sites whose screenshots are due
  // (asked for first, then captures past 90 days).
  if (REFRESH > 0 && !ONLY && !RECAPTURE) {
    const queued = new Set(queue.map((p) => p.url));
    const listed = new Map(feed.map((p) => [p.url, p]));
    const due = (await screenshotsDue(db, { limit: REFRESH + queue.length, active: ACTIVE }))
      .filter((u) => !queued.has(u) && listed.has(u))
      .slice(0, REFRESH);
    for (const u of due) queue.push({ ...listed.get(u), refresh: true });
    console.log(`refresh: re-capturing ${due.length} site(s) that were asked for or are 90 days old`);
  }
  console.log(`capturing ${queue.length} site(s), concurrency ${CONCURRENCY}, R2 ${s3 ? "on" : "off (local only)"}`);

  const { ok, skipped } = await captureQueue(queue, {
    concurrency: CONCURRENCY,
    capture: (browser, entry) => captureSite(browser, entry, { refresh: Boolean(entry.refresh), db, s3 }),
    recordCrash: (entry) => recordBrowserCrash(db, entry),
  });
  console.log(`done: ${ok} captured, ${skipped} gated out`);
}

/** The failure recorded for a site that took the browser down even when captured alone (captureQueue). */
export const CRASH_REASON = "the browser crashed on this site, also when it was captured alone";

/** Records CRASH_REASON for a site: a failed capture with backoff, or a refresh's backoff. */
export async function recordBrowserCrash(db, entry) {
  if (entry.refresh) await recordRefreshFailure(db, entry.url, `error: ${CRASH_REASON}`);
  else await recordCaptureFailure(db, entry.url, entry.name, "error", CRASH_REASON);
}

/** A run ends with an error once the browser fails to start this many times in a row. */
export const MAX_LAUNCH_FAILURES = 3;
/** A site in flight for this many browser deaths in one run is captured once more, alone in its own browser. */
export const ALONE_AFTER_DEATHS = 2;
/** A run ends with an error after this many captures in a row throw (the database unreachable, say). */
export const MAX_RUN_FAULTS = 3;

/**
 * Captures every entry of `queue`, `concurrency` at a time, on one shared
 * browser (`launch`, Playwright's chromium.launch by default). `capture` is
 * captureSite bound to the run's options; it records each site's own
 * failures and throws only what is not one site's fault.
 *
 *   - The browser going away: it is launched again (a failed launch is not
 *     remembered; MAX_LAUNCH_FAILURES failures in a row end the run with an
 *     error). Each site in flight (BROWSER_GONE) did nothing wrong as far as
 *     anyone knows: nothing is recorded and it goes back in line. A site in
 *     flight for ALONE_AFTER_DEATHS deaths is captured once more alone in a
 *     browser of its own; if that one dies too, the site is the cause:
 *     `recordCrash(entry)` records it with backoff. Its neighbours, whose
 *     deaths were someone else's, get the same clean run alone.
 *   - A fault of the run: a storage error no site causes (isRunFault) ends
 *     the run at once; any other throw ends it after MAX_RUN_FAULTS in a row
 *     (the database unreachable fails every site the same way). The run
 *     rejects, so the job exits non-zero.
 * Returns the counts.
 */
export async function captureQueue(
  queue,
  { capture, concurrency = 3, launch = () => chromium.launch(), log = console.log, retryPauseMs = 2000, recordCrash = async () => {} } = {}
) {
  const line = queue.map((entry) => ({ entry, deaths: 0 }));
  let faults = 0;
  /** A capture's result; a throw is a fault of the run (counted, and the run ends past the limit). */
  const attempt = async (b, entry) => {
    try {
      const result = await capture(b, entry);
      faults = 0;
      return result;
    } catch (e) {
      if (!b.isConnected()) return BROWSER_GONE;
      faults++;
      if (isRunFault(e) || faults >= MAX_RUN_FAULTS) throw new Error(`the run cannot go on (${faults} capture(s) in a row failed outside any site): ${String(e?.message ?? e).slice(0, 160)}`);
      return `error (${String(e?.message ?? e).slice(0, 80)})`;
    }
  };
  let browser = null;
  let launching = null;
  let launchFailures = 0;
  const liveBrowser = () => {
    if (browser?.isConnected()) return Promise.resolve(browser);
    launching ??= launch().then(
      (b) => {
        browser = b;
        launchFailures = 0;
        launching = null;
        return b;
      },
      (e) => {
        launchFailures++;
        launching = null;
        throw e;
      }
    );
    return launching;
  };
  let idx = 0,
    ok = 0,
    skipped = 0,
    requeued = 0;
  /** The launch failed: the run ends past the limit, else the site goes back in line. */
  const launchFailed = async (item, e) => {
    if (launchFailures >= MAX_LAUNCH_FAILURES) throw new Error(`the browser failed to start ${launchFailures} times in a row: ${String(e?.message ?? e).slice(0, 120)}`);
    line.push(item);
    log(`  the browser did not start (${String(e?.message ?? e).slice(0, 80)}); ${item.entry.url} goes back in line`);
    await new Promise((r) => setTimeout(r, retryPauseMs));
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, line.length) }, async () => {
        while (idx < line.length) {
          const item = line[idx++];
          const t = Date.now();
          let result;
          if (item.deaths >= ALONE_AFTER_DEATHS) {
            // In flight for every browser death so far: once more, alone in a browser of its own.
            let alone;
            try {
              alone = await launch();
              launchFailures = 0;
            } catch (e) {
              launchFailures++;
              await launchFailed(item, e);
              continue;
            }
            try {
              result = await attempt(alone, item.entry);
            } finally {
              await alone.close().catch(() => {});
            }
            if (result === BROWSER_GONE) {
              await recordCrash(item.entry);
              result = `error (${CRASH_REASON})`;
            }
          } else {
            let b;
            try {
              b = await liveBrowser();
            } catch (e) {
              await launchFailed(item, e);
              continue;
            }
            // captureSite has its own time limit (SITE_LIMIT_MS) and records its failures.
            result = await attempt(b, item.entry);
            if (result === BROWSER_GONE) {
              item.deaths++;
              requeued++;
              line.push(item);
              log(`[${idx}/${line.length}] ${item.entry.url} - ${result}: back in line (${((Date.now() - t) / 1000).toFixed(1)}s)`);
              continue;
            }
          }
          if (result.startsWith("live")) ok++;
          else skipped++;
          log(`[${idx}/${line.length}] ${item.entry.url} - ${result} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        }
      })
    );
  } finally {
    await browser?.close().catch(() => {});
  }
  return { ok, skipped, requeued };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
