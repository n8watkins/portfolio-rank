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
// the weekly change fingerprint found the page changed, the admin pressed
// "Re-measure" or the owner asked for a re-grade, or the capture is 90 days
// old (the nightly checks, sync-upstream.yml). Their screenshots, text,
// facts and page fingerprint are renewed, so a redesign is found
// (scripts/detect-changes.mjs) and re-graded the same night. A refresh that
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
// ./capture-blocked.mjs). The phone view is judged the same way. A site with
// no good capture records it as a failed capture and is retried (a bot wall
// also sets needs_review for the owner); a site that has one keeps it.
//
// Every site gets at most SITE_LIMIT_MS: a page that never answers (a main
// thread blocked after load) is closed, recorded as a failed capture with the
// normal backoff, and the run goes on.
import { chromium } from "playwright";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { httpGate, isParkingDomain, netloc, parkingPhrase, readRenderedPage, UA } from "./gate.mjs";
import { measurePage } from "./facts.mjs";
import { pngDiff } from "./png-diff.mjs";
import { actionNote, passModal, passModePicker, passSplashGate } from "./splash.mjs";
import { BLOCKED_PREFIX, BOT_WALL, capturedBlocked, httpVerdict, readBlockedInputs } from "./capture-blocked.mjs";
import { inconclusiveGate, shot, waitForContent } from "./capture-steps.mjs";
import { normalizePageText } from "./rubric.mjs";
import {
  ACTIVE,
  captureRetryAt,
  dueForCapture,
  ensureRosterSchema,
  pipelineDb,
  syncRoster,
} from "./roster.mjs";
import { clearRefreshFailure, ensureFreshnessSchema, recordRefreshFailure, screenshotsDue } from "../lib/freshness.mjs";
import { IMAGE_FILES, captureView, fullPageComplete, nextFullPage, settleFirstScreen } from "./fullpage.mjs";
import { deleteVersion, imagesBucket, legacyFramesOn, notStored, storeVersion } from "./shot-store.mjs";
import { SERVE_FILES, contentTypeOf } from "./shot-files.mjs";

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
/** The row's stored capture: { fullPage (meta.fullPage or null), good (a live row with screenshots) }. */
async function storedCapture(db, url) {
  const row = (await db.execute({ sql: "SELECT status, shot_key, meta FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const good = Boolean(row && String(row.status) === "live" && row.shot_key != null);
  try {
    return { good, fullPage: JSON.parse(String(row?.meta ?? "null"))?.fullPage ?? null };
  } catch {
    return { good, fullPage: null };
  }
}

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

/** The longest one site's capture may take, everything included; a normal one takes one to three minutes. */
export const SITE_LIMIT_MS = 5 * 60 * 1000;
/** How long closing a timed-out capture's browser context is waited for. */
const CLOSE_LIMIT_MS = 15000;

/**
 * Follows a page's main document: the status and cf-mitigated header of the
 * last response its own navigation got (a challenge that reloads into the
 * site ends on the site's response). { status: 0 } until there is one.
 * @param {import("playwright").Page} page
 */
function trackDocument(page) {
  const doc = { status: 0, cfMitigated: "" };
  page.on("response", (res) => {
    try {
      if (res.frame() !== page.mainFrame() || !res.request().isNavigationRequest()) return;
      doc.status = res.status();
      doc.cfMitigated = res.headers()["cf-mitigated"] ?? "";
    } catch {
      // a response without a frame (a service worker's): not the document
    }
  });
  return doc;
}

/** The one-line result of a verdict or a blocked reason: "blocked (...)" for a blocked reason, else "<status> (<reason>)". */
const resultOf = (status, reason) =>
  String(reason).startsWith(BLOCKED_PREFIX) ? `blocked (${String(reason).slice(BLOCKED_PREFIX.length)})` : `${status} (${reason})`;

/**
 * Whether a loaded view (desktop or phone) is not the site, after its passes
 * and waits: { status, reason, needsReview } or null. In order: the main
 * document's HTTP status (./capture-blocked.mjs httpVerdict), a parked
 * domain on the rendered page (./gate.mjs, as the plain pre-check reads the
 * served one), then capturedBlocked. `suffix` marks the phone view's reasons.
 * @param {import("playwright").Page} page
 */
async function judgeView(page, doc, passes, suffix = "") {
  const shown = await readBlockedInputs(page);
  const verdict = httpVerdict({ status: doc.status, cfMitigated: doc.cfMitigated, text: shown.text, title: shown.title, shown: { ...shown, ...passes } });
  if (verdict) return { ...verdict, reason: `${verdict.reason}${suffix}` };
  const finalUrl = page.url();
  if (isParkingDomain(finalUrl)) return { status: "parked", reason: `redirects to ${netloc(finalUrl)}${suffix}`, needsReview: false };
  const phrase = parkingPhrase({ text: shown.text, title: shown.title });
  if (phrase) return { status: "parked", reason: `parking phrase: "${phrase}"${suffix}`, needsReview: false };
  const blocked = capturedBlocked({ ...shown, ...passes });
  if (blocked) return { status: "error", reason: `${BLOCKED_PREFIX}${blocked}${suffix}`, needsReview: blocked === BOT_WALL };
  return null;
}

/**
 * Captures one site into `root`/captures/<key>/ and its `portfolios` row.
 * `db`: the pipeline database; `s3`: an R2 client or null (local only);
 * `limitMs`: the most the whole capture may take (SITE_LIMIT_MS): past it the
 * site's browser context is closed and a failed capture recorded.
 * Returns a one-line result; "live" first when the capture was stored.
 */
export async function captureSite(browser, entry, { refresh = false, db, s3 = null, root = ROOT, limitMs = SITE_LIMIT_MS } = {}) {
  const { url, name } = entry;
  // A refresh never marks a site failed (see the header): it only waits out a backoff.
  const record = refresh
    ? (status, reason) => recordRefreshFailure(db, url, `${status}: ${reason}`)
    : (status, reason, opts) => recordCaptureFailure(db, url, name, status, reason, opts);
  // run.aborted: the time limit passed, so the capture must write nothing more;
  // run.committed: the good capture is being written, so the limit waits for it;
  // run.storedGood: the site has a good capture, which a failed one never marks failed.
  const run = { aborted: false, committed: false, storedGood: false, ctx: null };
  const keepsGood = () => run.storedGood && !refresh;
  const fail = async (...a) => {
    if (!run.aborted && !keepsGood()) await record(...a);
  };
  const TIMED_OUT = Symbol("timed out");
  let timer;
  const work = captureOnce(browser, entry, { refresh, db, s3, root, fail }, run);
  const out = await Promise.race([work, new Promise((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), limitMs)))]);
  clearTimeout(timer);
  if (out !== TIMED_OUT) return out;
  if (run.committed) return work;
  run.aborted = true;
  work.catch(() => {});
  // Closing the context kills the page, also one whose main thread never returns.
  if (run.ctx) await Promise.race([run.ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_LIMIT_MS))]);
  const reason = `capture timed out after ${Math.round(limitMs / 1000)}s`;
  if (keepsGood()) return `error (${reason}); the existing capture is kept`;
  await record("error", reason);
  return `error (${reason})`;
}

/** captureSite's work, without the time limit; `fail` records a failed capture, `run` is the limit's state. */
async function captureOnce(browser, entry, { refresh, db, s3, root, fail }, run) {
  const { url, name } = entry;
  const key = keyOf(url);
  const dir = path.join(root, "captures", key);
  const IMAGES_BUCKET = imagesBucket();

  const gate = await httpGate(url);
  // A 401/403/429/503 or a TLS failure on the plain request is often a bot filter or a
  // certificate a browser accepts: the browser decides (./capture-steps.mjs), and the
  // status its main document ends on decides again below (judgeView).
  if (gate.status !== "live" && !inconclusiveGate(gate)) {
    await fail(gate.status, gate.reason);
    return `${gate.status} (${gate.reason})`;
  }

  // The stored images, to keep them when the page looks the same, and
  // whether the site already has a good capture (a failed one never replaces it).
  const stored = await storedCapture(db, url);
  const prevFullPage = stored.fullPage;
  run.storedGood = stored.good;

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    ignoreHTTPSErrors: true,
  });
  run.ctx = ctx;
  if (run.aborted) {
    await ctx.close().catch(() => {});
    return "aborted";
  }

  // A capture that is not the site: nothing of it is stored. A site with a
  // good capture keeps it (a refresh only waits out its backoff); one
  // without is a failed capture with its reason, retried later with backoff.
  const reject = async ({ status, reason, needsReview = false }) => {
    await ctx.close().catch(() => {});
    await fail(status, reason, { needsReview });
    const result = resultOf(status, reason);
    return refresh || stored.good ? `${result}; the existing capture is kept` : result;
  };

  const page = await ctx.newPage();
  const doc = trackDocument(page);

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
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    // Let SPAs/preloaders settle: idle network if it comes, then a beat.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

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
    const rendered = await page.evaluate(readRenderedPage);
    if (rendered.text.trim().length < 30 && !rendered.media) {
      // A blank error page is the error it answered with.
      const verdict = httpVerdict({ status: doc.status, cfMitigated: doc.cfMitigated, text: rendered.text, title: await page.title().catch(() => "") });
      return reject(verdict ?? { status: "dead", reason: "renders blank" });
    }

    // Wait out slow preloaders and intro animations: poll until both the
    // viewport and its center (spinners, percent counters) hold still for
    // two polls. Pages that churn the whole viewport every poll are
    // animated backgrounds, not loaders — bail early and call it motion.
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

    // Page text and facts from the settled, rendered page (single-page apps
    // included), plus a capped check of its project and demo links.
    const settled = await page.evaluate(readRenderedPage).catch(() => rendered);
    const pageText = normalizePageText(settled.text);
    const facts = await measurePage(
      { html: settled.html, text: settled.text, url, finalUrl: page.url(), name, motion, source: "rendered" },
      { userAgent: UA }
    ).catch(() => null);

    // The diagnostics as they stand now: the scroll-through below loads
    // lazy content, which must not change the page weight or the errors.
    const diagnostics = {
      consoleErrors: consoleErrors.length,
      consoleSample: consoleErrors.slice(0, 5),
      requests,
      bytes,
      broken404s: broken,
    };

    // The tall desktop image: scroll through once, back to the top, stitch
    // (pipeline/fullpage.mjs). Its first screenful is the grade's hero.jpg;
    // if the stitch fails, a plain screenshot of the top stands in.
    const desktopView = await captureView(page, "desktop");

    // Not the site (judgeView): an error status, a parked domain, or a
    // screen that after the passes, the waits and the scroll-through is
    // still blocked (./capture-blocked.mjs). Nothing of it is stored,
    // uploaded or graded (reject). A bot wall is not called broken: it is
    // marked for the owner's review.
    const desktopVerdict = await judgeView(page, doc, { splash, modal, mode });
    if (desktopVerdict) return reject(desktopVerdict);
    const heroJpg = desktopView.ok ? desktopView.files.crop : await shot(page, { type: "jpeg", quality: 75 });

    // Phone: the same page at 390 wide, horizontal-overflow check, then the
    // tall phone image, whose top is mobile.jpg.
    const mpage = await ctx.newPage();
    const mdoc = trackDocument(mpage);
    await mpage.setViewportSize({ width: 390, height: 844 });
    await mpage.goto(url, { waitUntil: "load", timeout: 30000 });
    await mpage.waitForTimeout(1500);
    // The phone view starts at the gate, the dialog and the picker too.
    const mobileSplash = await passSplashGate(mpage).catch(() => null);
    const mobileModal = await passModal(mpage).catch(() => null);
    const mobileMode = await passModePicker(mpage).catch(() => null);
    // The desktop view already waited for content; the phone view gets the same chance.
    await waitForContent(mpage);
    // Its intro plays again on this load: a short wait for a still first screen.
    await settleFirstScreen(mpage, { polls: 4, diff: pngDiff }).catch(() => false);
    const overflow390 = await mpage.evaluate(
      () => document.documentElement.scrollWidth > 395
    );
    const phoneView = await captureView(mpage, "phone");
    // The phone view is graded too (mobile.jpg): it must show the site as well.
    const phoneVerdict = await judgeView(mpage, mdoc, { splash: mobileSplash, modal: mobileModal, mode: mobileMode }, " (phone view)");
    if (phoneVerdict) return reject(phoneVerdict);
    const mobileJpg = phoneView.ok ? phoneView.files.crop : await shot(mpage, { type: "jpeg", quality: 75 });

    await ctx.close();
    if (run.aborted) return "aborted";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hero.jpg"), heroJpg);
    fs.writeFileSync(path.join(dir, "mobile.jpg"), mobileJpg);

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
    if (s3 && IMAGES_BUCKET && uploadImages && fullPageComplete(fullPage)) {
      const commands = await import("@aws-sdk/client-s3");
      if (run.aborted) return "aborted";
      await storeVersion({
        send: (c) => s3.send(c),
        commands,
        bucket: IMAGES_BUCKET,
        shotKey: key,
        v: fullPage.v,
        files: {
          [IMAGE_FILES.desktop.tall]: desktopView.files.tall,
          [IMAGE_FILES.desktop.thumb]: desktopView.files.thumb,
          [IMAGE_FILES.phone.tall]: phoneView.files.tall,
          [IMAGE_FILES.phone.thumb]: phoneView.files.thumb,
        },
      });
      uploadedV = fullPage.v;
    }

    const meta = {
      ...diagnostics,
      overflow390,
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
      fullPage,
    };

    // The old frames, cut from the tall images, while the site still reads
    // them; not when nothing changed.
    if (legacyFramesOn() && uploadLegacy) await uploadDir(s3, key, dir);

    if (run.aborted) throw new Error("aborted");
    run.committed = true;
    await db.execute({
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
    // Stored: a refresh backoff ends, and the old images go now that nothing points at them.
    // Neither can undo the capture: a failure here is only logged.
    await clearRefreshFailure(db, url).catch((e) => console.warn(`  ${url}: refresh backoff not cleared (${String(e?.message ?? e).slice(0, 80)})`));
    if (uploadedV && prevFullPage?.v && prevFullPage.v !== uploadedV) {
      const commands = await import("@aws-sdk/client-s3");
      await deleteVersion({ send: (c) => s3.send(c), commands, bucket: IMAGES_BUCKET, shotKey: key, v: prevFullPage.v }).catch((e) =>
        console.warn(`  ${url}: old images ${key}/${prevFullPage.v} not deleted (${String(e?.message ?? e).slice(0, 80)})`)
      );
    }
    return `live → ${key} (motion=${meta.motion} dark=${meta.darkMode} overflow=${meta.overflow390})`;
  } catch (e) {
    await ctx.close().catch(() => {});
    // A new version uploaded for a capture that was not stored is nobody's: remove it.
    if (uploadedV && uploadedV !== prevFullPage?.v) {
      const commands = await import("@aws-sdk/client-s3").catch(() => null);
      if (commands) await deleteVersion({ send: (c) => s3.send(c), commands, bucket: IMAGES_BUCKET, shotKey: key, v: uploadedV }).catch(() => {});
    }
    if (run.aborted) return "aborted";
    await fail("error", String(e.message ?? e).slice(0, 200));
    const result = `error (${String(e.message ?? e).slice(0, 80)})`;
    return refresh || stored.good ? `${result}; the existing capture is kept` : result;
  }
}

// ---------------------------------------------------------------------------
// Main (only when run as a script: the tests import captureSite)
// ---------------------------------------------------------------------------
async function main() {
  // env (.env.local, no dotenv dependency). Optional: in CI (GitHub Actions)
  // there's no .env.local — the vars come straight from the runner env/secrets.
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
      console.error("R2_* env vars missing — nothing to upload to.");
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
  // (changed or asked for first, then captures past 90 days).
  if (REFRESH > 0 && !ONLY && !RECAPTURE) {
    const queued = new Set(queue.map((p) => p.url));
    const listed = new Map(feed.map((p) => [p.url, p]));
    const due = (await screenshotsDue(db, { limit: REFRESH + queue.length, active: ACTIVE }))
      .filter((u) => !queued.has(u) && listed.has(u))
      .slice(0, REFRESH);
    for (const u of due) queue.push({ ...listed.get(u), refresh: true });
    console.log(`refresh: re-capturing ${due.length} site(s) that changed, were asked for, or are 90 days old`);
  }
  console.log(`capturing ${queue.length} site(s), concurrency ${CONCURRENCY}, R2 ${s3 ? "on" : "off (local only)"}`);

  let browser = await chromium.launch();
  let relaunching = null;
  /** The shared browser, launched again if it went away (a crash must not end the run). */
  const liveBrowser = async () => {
    if (browser.isConnected()) return browser;
    relaunching ??= chromium.launch().then((b) => {
      browser = b;
      relaunching = null;
      return b;
    });
    return relaunching;
  };
  let idx = 0,
    ok = 0,
    skipped = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (idx < queue.length) {
        const entry = queue[idx++];
        const t = Date.now();
        // captureSite has its own time limit (SITE_LIMIT_MS) and records its failures;
        // anything it still throws (the browser gone) is logged and the run goes on.
        const result = await liveBrowser()
          .then((b) => captureSite(b, entry, { refresh: Boolean(entry.refresh), db, s3 }))
          .catch((e) => `error (${String(e?.message ?? e).slice(0, 80)})`);
        if (result.startsWith("live")) ok++;
        else skipped++;
        console.log(`[${idx}/${queue.length}] ${entry.url} — ${result} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      }
    })
  );
  await browser.close();
  console.log(`done: ${ok} captured, ${skipped} gated out`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
