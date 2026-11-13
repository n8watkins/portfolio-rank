// The capture's page images (owner-approved design, 2026-11-13): one visit
// per site, and from it one tall desktop image (1440 wide) and one tall
// phone image (390 wide), plus a small thumbnail of each one's top.
//
//   <shot_key>/<v>/desktop.avif        1440 wide, at most 4,000 px tall
//   <shot_key>/<v>/phone.avif           390 wide, at most 6,000 px tall
//   <shot_key>/<v>/desktop-thumb.avif   480 wide: the top 1440 x 900, scaled
//   <shot_key>/<v>/phone-thumb.avif     240 wide: the top 390 x 844, scaled
//
// <v> is the version (the capture's time in base 36), so every object is
// immutable and can be cached for a year anywhere; a new version replaces
// the old one, which is then deleted (pipeline/shot-store.mjs).
//
// The top of each tall image (1440 x 900 and 390 x 844) is also cut out as
// a JPEG at capture time: the grade's image (pipeline/rubric.mjs reads
// captures/<key>/hero.jpg) and, while the pages still use them, the old
// hero.jpg and mobile.jpg (pipeline/shot-store.mjs LEGACY_FRAMES). Gemini
// does not read AVIF, so the grade's image stays a JPEG.
//
// How a tall image is made: the page is scrolled through once, top to
// bottom (lazy images and infinite lists load, within a time budget), then
// it is stitched from one viewport screenshot per screenful from the top
// (stitchPage says why). sharp (libvips) joins the tiles and encodes AVIF.
// Nothing here is retried: a frame that fails is recorded as an error.
import { createHash } from "crypto";
import sharp from "sharp";

/** The two views: viewport, height cap and thumbnail width. */
export const FRAMES = {
  desktop: { width: 1440, viewportHeight: 900, maxHeight: 4000, thumbWidth: 480 },
  phone: { width: 390, viewportHeight: 844, maxHeight: 6000, thumbWidth: 240 },
};

/** The stored files of one version, by view. */
export const IMAGE_FILES = {
  desktop: { tall: "desktop.avif", thumb: "desktop-thumb.avif" },
  phone: { tall: "phone.avif", thumb: "phone-thumb.avif" },
};
export const ALL_IMAGE_FILES = Object.values(IMAGE_FILES).flatMap((f) => [f.tall, f.thumb]);

// AVIF settings, tuned on lossless stitched pages of six sample sites
// (docs/audits/fullpage-images.md "Format"): quality 40 at effort 3 with
// 4:2:0 chroma matches today's JPEG 75 (35.6 against 35.8 dB desktop,
// 32.8 against 32.8 phone, text indistinguishable) at about a quarter of
// its bytes, and encodes in about 1.5 s a tall desktop image; sharp's
// default effort 4 took 7.6 s for 2% fewer bytes. Thumbnails, whose text
// is scaled down, get quality 50.
export const AVIF_TALL = { quality: 40, effort: 3, chromaSubsampling: "4:2:0" };
export const AVIF_THUMB = { quality: 50, effort: 3, chromaSubsampling: "4:2:0" };
/** The grade's image and the old frames: JPEG quality 75, as before. */
export const JPEG_QUALITY = 75;

// The scroll-through: steps of 80% of the viewport, a short pause on each so
// lazy images start loading, and a hard budget so an endless page (infinite
// scroll, a scroll-jacking library that never reaches the bottom) ends.
const SCROLL_PAUSE_MS = 150;
const SCROLL_BUDGET_MS = 10000;
// After the scroll: the images it started, then a beat for layout to settle.
const IMAGES_WAIT_MS = 4000;
const SETTLE_MS = 600;
// Each tile: a beat for scroll-triggered effects driven by script (CSS ones
// are finished by the screenshot), and its images, bounded.
const TILE_SETTLE_MS = 700;
const TILE_IMAGES_WAIT_MS = 1500;
const SHOT_TIMEOUT_MS = 30000;
// The time a view may take, scroll-through and tiles together (owner, 2026-11-13:
// about 30 s a site for both views, encoding included; one page took 107 s
// before this).
// The scroll-through gets at most 40% of it. Once it is used up no new tile
// starts and the image ends there (`timeCut`); the first screen is always taken.
export const VIEW_BUDGET_MS = 13000;

/** A version tag for a time: seconds in base 36 (lib/shots.ts uses the same for ?v=). */
export const versionOf = (date) => Math.floor(date.getTime() / 1000).toString(36);

// The scroll target. Most pages scroll the window. Some keep html and body
// one screen tall and scroll an element inside instead (a full-height
// <main> or wrapper with overflow: auto); the window then never moves and a
// stitch of the window is one screen. When the window cannot scroll, the
// target is the tallest scrollable element that covers at least half the
// viewport both ways; it is marked data-pr-scroller and everything below
// scrolls it. Its layout: `top` (where its visible box starts in the
// viewport), `view` (its visible height), `below` (viewport rows under it)
// and `height` (its content height); for the window, top 0, view the
// viewport, below 0 and the document's height.
const MARK_SCROLL_TARGET = () => {
  for (const e of document.querySelectorAll("[data-pr-scroller]")) e.removeAttribute("data-pr-scroller");
  // Smooth scrolling and scroll snapping would move the target somewhere
  // other than asked; neither changes how the page looks.
  const calm = (e) => {
    e.style.setProperty("scroll-behavior", "auto", "important");
    e.style.setProperty("scroll-snap-type", "none", "important");
  };
  calm(document.documentElement);
  if (document.body) calm(document.body);
  const vh = window.innerHeight;
  const se = document.scrollingElement || document.documentElement;
  const docHeight = Math.max(se.scrollHeight, document.body?.scrollHeight ?? 0, vh);
  if (docHeight > vh + 2) return { element: null, top: 0, view: vh, below: 0, height: docHeight };
  let best = null;
  for (const e of document.querySelectorAll("body *")) {
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) continue;
    if (e.clientHeight < vh * 0.5 || e.clientWidth < window.innerWidth * 0.5 || e.scrollHeight <= e.clientHeight + 50) continue;
    const r = e.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh) continue;
    if (!best || e.scrollHeight > best.scrollHeight) best = e;
  }
  if (!best) return { element: null, top: 0, view: vh, below: 0, height: docHeight };
  best.setAttribute("data-pr-scroller", "1");
  calm(best);
  const top = Math.max(0, Math.round(best.getBoundingClientRect().top + best.clientTop));
  const view = Math.min(best.clientHeight, vh - top);
  return { element: best.tagName.toLowerCase(), top, view, below: Math.max(0, vh - top - view), height: best.scrollHeight };
};

// The page's headings (h1 to h3) with their position on the tall image:
// { level, text, y }, at most OUTLINE_MAX, in page order. Measured with the
// target at the top: for the window that is the document position; for an
// element, the rows above its box plus the heading's place in its content.
// Hidden headings (display none, zero size) are left out.
const OUTLINE_MAX = 40;
const OUTLINE = (max) => {
  const el = document.querySelector("[data-pr-scroller]");
  // The image's rows: for the window, the document's; for an element, the
  // viewport rows above its box, then its content, then the rows below it.
  const box = el ? { top: el.getBoundingClientRect().top + el.clientTop, bottom: el.getBoundingClientRect().top + el.clientTop + el.clientHeight } : null;
  const out = [];
  for (const h of document.querySelectorAll("h1, h2, h3")) {
    const r = h.getBoundingClientRect();
    const text = (h.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text || r.height === 0 || r.width === 0) continue;
    let y;
    if (!el) y = r.top + window.scrollY;
    else if (el.contains(h)) y = r.top + el.scrollTop;
    else if (r.top >= box.bottom) y = r.top - box.bottom + box.top + el.scrollHeight;
    else y = r.top;
    out.push({ level: Number(h.tagName[1]), text, y: Math.max(0, Math.round(y)) });
    if (out.length >= max) break;
  }
  return out;
};

/** Finds and marks the page's scroll target (MARK_SCROLL_TARGET). */
export const scrollTargetOf = (page) => page.evaluate(MARK_SCROLL_TARGET);

/** Scrolls the marked target (or the window) to `y`; returns where it got to. */
const SCROLL_TO = (y) => {
  const el = document.querySelector("[data-pr-scroller]");
  if (el) {
    el.scrollTo({ top: y, left: 0, behavior: "instant" });
    return Math.round(el.scrollTop);
  }
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return Math.round(window.scrollY);
};

/**
 * Scrolls the page's scroll target (scrollTargetOf; the window unless the
 * page scrolls inside an element) from top to bottom once (to the height
 * cap at most) and back to the top. Runs in the page; returns how far it
 * got and whether it stopped on the time budget.
 */
export async function scrollThrough(page, { maxHeight, pauseMs = SCROLL_PAUSE_MS, budgetMs = SCROLL_BUDGET_MS }) {
  const run = page.evaluate(
    async ({ maxHeight, pauseMs, budgetMs }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const el = document.querySelector("[data-pr-scroller]");
      const height = () => (el ? el.scrollHeight : Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      const view = el ? el.clientHeight : window.innerHeight;
      const to = (y) => (el ? el.scrollTo({ top: y, left: 0, behavior: "instant" }) : window.scrollTo({ top: y, left: 0, behavior: "instant" }));
      const start = performance.now();
      const step = Math.max(200, Math.floor(view * 0.8));
      let y = 0;
      let outOfTime = false;
      for (;;) {
        const bottom = Math.min(height(), maxHeight) - view;
        if (y >= bottom) break;
        if (performance.now() - start > budgetMs) {
          outOfTime = true;
          break;
        }
        y = Math.min(y + step, bottom);
        to(y);
        await sleep(pauseMs);
      }
      to(0);
      return { reached: y, outOfTime };
    },
    { maxHeight, pauseMs, budgetMs }
  );
  // The page's own timers can't hold the capture: a page that blocks its
  // main thread gets the budget plus a margin, then the shot goes ahead.
  return Promise.race([run, new Promise((r) => setTimeout(() => r({ reached: null, outOfTime: true }), budgetMs + 5000))]);
}

/**
 * Waits (bounded) for the images the scroll started to finish loading: the
 * unfinished ones above `maxHeight` (a lazy image below it never starts).
 */
async function imagesLoaded(page, maxHeight, timeoutMs = IMAGES_WAIT_MS) {
  await page
    .evaluate(
      ({ maxHeight, timeoutMs }) =>
        Promise.race([
          Promise.all(
            [...document.images]
              .filter((img) => !img.complete && img.getBoundingClientRect().top + (document.querySelector("[data-pr-scroller]")?.scrollTop ?? window.scrollY) < maxHeight)
              .map(
                (img) =>
                  new Promise((r) => {
                    img.addEventListener("load", r, { once: true });
                    img.addEventListener("error", r, { once: true });
                  })
              )
          ),
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]),
      { maxHeight, timeoutMs }
    )
    .catch(() => {});
}

/**
 * The height to capture: the page's own, at least one viewport (a page whose
 * content sits in its own scrolling box reports the viewport) and at most
 * the cap. `cropped` when the page is taller than the cap.
 */
export function shotHeight(pageHeight, viewportHeight, maxHeight) {
  const h = Math.max(Math.ceil(Number(pageHeight) || 0), viewportHeight);
  return { height: Math.min(h, maxHeight), cropped: h > maxHeight };
}

/**
 * The rows of the stitched image a tile adds. The tile was taken with the
 * page scrolled to `actual` (the browser may stop short of the asked-for
 * `y` at the bottom); the image needs rows `y` up to `height`. Returns
 * { offset, rows } (where in the tile they start, and how many), or null
 * when the tile adds nothing (the page stopped scrolling).
 */
export function tileRows({ y, actual, viewportHeight, height }) {
  const offset = y - actual;
  if (offset < 0 || offset >= viewportHeight) return null;
  const rows = Math.min(viewportHeight - offset, height - y);
  return rows > 0 ? { offset, rows } : null;
}

// After the first tile, fixed and sticky bars (headers, chat buttons, cookie
// notices: under half the viewport tall) are hidden, so they show once at
// the top instead of on every tile. Taller fixed layers (a full-screen
// background) stay: they really are behind every part of the page.
const HIDE_FIXED = () => {
  for (const el of document.querySelectorAll("body *")) {
    const pos = getComputedStyle(el).position;
    if ((pos === "fixed" || pos === "sticky") && el.getBoundingClientRect().height < window.innerHeight / 2) {
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
};

/**
 * The tall image of an open, loaded, settled page whose viewport is the
 * view's size. Returns { raw, width, height, pageHeight, cropped, top,
 * scrollStopped?, scrollCut?, ms }: `raw` is the stitched image as raw RGB,
 * `top` the first screenful as PNG (the same pixels as a viewport
 * screenshot at the top).
 *
 * Stitched from viewport screenshots, one per screenful from the top: many
 * portfolios show a section only while it is in view (scroll-linked
 * opacity, reveal animations that play back when scrolled away), so one
 * screenshot of the whole document leaves everything below the first
 * screen blank. Each tile shows the page the way a visitor scrolling there
 * sees it.
 *
 * The page's scroll target is scrolled (scrollTargetOf): the window, or the
 * element a page scrolls inside. The image is laid out as the viewport
 * rows above the target's box (from the first tile), the target's whole
 * content (each tile adds what came into its box), then the rows below its
 * box (from the last tile). For the window that is simply one screenful
 * after another. If the target stops scrolling before the height, the image
 * ends where scrolling did (`scrollStopped`). Fixed bars are hidden after
 * the first tile and the target is left scrolled to the top.
 */
export async function stitchPage(page, view, { budgetMs = VIEW_BUDGET_MS } = {}) {
  const t = Date.now();
  const left = () => Math.max(0, t + budgetMs - Date.now());
  const viewport = page.viewportSize() ?? { width: view.width, height: view.viewportHeight };
  const vh = viewport.height;
  await scrollTargetOf(page);
  const scroll = await scrollThrough(page, { maxHeight: view.maxHeight, budgetMs: Math.min(SCROLL_BUDGET_MS, Math.round(budgetMs * 0.4)) });
  await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(3000, left())) }).catch(() => {});
  await imagesLoaded(page, view.maxHeight, Math.min(IMAGES_WAIT_MS, left()));
  // Measured again after the scroll: lazy content makes the target taller.
  const target = await scrollTargetOf(page);
  // Headings and their rows on the image, with the target at the top.
  await page.evaluate(SCROLL_TO, 0).catch(() => {});
  const outline = await page.evaluate(OUTLINE, OUTLINE_MAX).catch(() => []);
  const pageHeight = target.top + target.height + target.below;
  const { height: wantedTotal, cropped } = shotHeight(pageHeight, vh, view.maxHeight);
  // The target's content rows the image has room for.
  const wanted = Math.max(target.view, wantedTotal - target.top - target.below);

  const tiles = [];
  let top = null;
  let last = null;
  let covered = 0;
  let timeCut = false;
  for (let y = 0; y < wanted; y += target.view) {
    if (y > 0 && left() === 0) {
      timeCut = true;
      break;
    }
    const actual = await page.evaluate(SCROLL_TO, y);
    await page.waitForTimeout(y === 0 ? SETTLE_MS : Math.min(TILE_SETTLE_MS, left()));
    await imagesLoaded(page, y + vh, Math.min(TILE_IMAGES_WAIT_MS, left()));
    const part = tileRows({ y, actual, viewportHeight: target.view, height: wanted });
    if (!part) break;
    // Finite CSS animations and transitions (most reveal effects) are shown
    // at their end state.
    const png = await page.screenshot({ type: "png", animations: "disabled", timeout: SHOT_TIMEOUT_MS });
    if (y === 0) {
      top = png;
      // The rows above the target and its first part.
      const rows = target.top + part.rows;
      tiles.push({ input: rows === vh ? png : await sharp(png).extract({ left: 0, top: 0, width: viewport.width, height: rows }).toBuffer(), top: 0, left: 0 });
    } else {
      const input = await sharp(png).extract({ left: 0, top: target.top + part.offset, width: viewport.width, height: part.rows }).toBuffer();
      tiles.push({ input, top: target.top + y, left: 0 });
    }
    last = png;
    covered = y + part.rows;
    if (y === 0) await page.evaluate(HIDE_FIXED).catch(() => {});
  }
  await page.evaluate(SCROLL_TO, 0).catch(() => {});
  if (!covered || !top) throw new Error("no tile was taken");
  // The rows below the target's box, from the last tile.
  if (target.below > 0 && last) {
    const input = await sharp(last).extract({ left: 0, top: vh - target.below, width: viewport.width, height: target.below }).toBuffer();
    tiles.push({ input, top: target.top + covered, left: 0 });
  }
  const height = target.top + covered + target.below;

  const raw = await sharp({ create: { width: viewport.width, height, channels: 3, background: "#ffffff" } })
    .composite(tiles)
    .removeAlpha()
    .raw()
    .toBuffer();
  return {
    raw,
    width: viewport.width,
    height,
    pageHeight: Math.round(pageHeight),
    cropped,
    top,
    ms: Date.now() - t,
    outline,
    ...(target.element ? { scroller: target.element } : {}),
    ...(covered < wanted && !timeCut ? { scrollStopped: true } : {}),
    ...(scroll.outOfTime ? { scrollCut: true } : {}),
    ...(timeCut ? { timeCut: true } : {}),
  };
}

const fromRaw = (s) => sharp(s.raw, { raw: { width: s.width, height: s.height, channels: 3 } });

// Visual signature: the image scaled to SIG_COLS columns and one row per
// SIG_ROW_PX pixels, grey, 16 levels a cell. Two captures look the same
// when the sizes match and at most SIG_MAX_CHANGED of the cells moved by
// more than one level (a carousel, a clock or a cursor blink stay under).
const SIG_COLS = 16;
const SIG_ROW_PX = 90;
export const SIG_MAX_CHANGED = 0.01;

/** The stitched image's visual signature: { w, h, cells } (cells: base64, 4 bits each). */
export async function visualSignature(stitched) {
  const rows = Math.max(1, Math.round(stitched.height / SIG_ROW_PX));
  const grey = await fromRaw(stitched).resize(SIG_COLS, rows, { fit: "fill" }).greyscale().raw().toBuffer();
  const packed = Buffer.alloc(Math.ceil(grey.length / 2));
  for (let i = 0; i < grey.length; i++) packed[i >> 1] |= (grey[i] >> 4) << (i % 2 ? 0 : 4);
  return { w: stitched.width, h: stitched.height, cells: packed.toString("base64") };
}

/** Whether two signatures look the same (see visualSignature). */
export function sameLook(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h || a.cells.length !== b.cells.length) return false;
  const x = Buffer.from(a.cells, "base64");
  const y = Buffer.from(b.cells, "base64");
  let changed = 0;
  const n = x.length * 2;
  for (let i = 0; i < n; i++) {
    const p = i % 2 ? x[i >> 1] & 15 : x[i >> 1] >> 4;
    const q = i % 2 ? y[i >> 1] & 15 : y[i >> 1] >> 4;
    if (Math.abs(p - q) > 1) changed++;
  }
  return changed <= n * SIG_MAX_CHANGED;
}

/**
 * Encodes one stitched view: { tall, thumb } (AVIF), `crop` (the top
 * screenful as JPEG, for the grade and the old frames) and its signature.
 */
export async function encodeView(stitched, view) {
  const [tall, thumb, crop, sig] = await Promise.all([
    fromRaw(stitched).avif(AVIF_TALL).toBuffer(),
    sharp(stitched.top).resize({ width: view.thumbWidth }).avif(AVIF_THUMB).toBuffer(),
    sharp(stitched.top).jpeg({ quality: JPEG_QUALITY, mozjpeg: false }).toBuffer(),
    visualSignature(stitched),
  ]);
  return { tall, thumb, crop, sig };
}

/**
 * One view, from stitch to encoded files, never throwing: { ok: true,
 * meta, files } or { ok: false, meta: { error } }. `meta` is what the
 * row keeps: { width, height, pageHeight, cropped, bytes, thumbBytes, ms,
 * sig, ... }.
 */
export async function captureView(page, name, { budgetMs } = {}) {
  const view = FRAMES[name];
  try {
    const t = Date.now();
    const s = await stitchPage(page, view, budgetMs ? { budgetMs } : {});
    const files = await encodeView(s, view);
    return {
      ok: true,
      files,
      meta: {
        width: s.width,
        height: s.height,
        pageHeight: s.pageHeight,
        cropped: s.cropped,
        bytes: files.tall.length,
        thumbBytes: files.thumb.length,
        ms: Date.now() - t,
        sig: files.sig,
        outline: s.outline.filter((h) => h.y < s.height),
        ...(s.scroller ? { scroller: s.scroller } : {}),
        ...(s.scrollStopped ? { scrollStopped: true } : {}),
        ...(s.timeCut ? { timeCut: true } : {}),
        ...(s.scrollCut ? { scrollCut: true } : {}),
      },
    };
  } catch (e) {
    return { ok: false, meta: { error: String(e?.message ?? e).split("\n")[0].slice(0, 200) } };
  }
}

/** A short hash of the page text, so a text change is never taken for "looks the same". */
export const textHash = (text) => createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 16);

/**
 * Whether a new capture looks like the stored one: both views' signatures
 * match and the page text is the same. Then nothing is uploaded and the
 * stored version (and every cached copy of it) stays.
 */
export function unchanged(prev, next) {
  return Boolean(
    prev?.v && prev.textHash && prev.textHash === next.textHash && sameLook(prev.desktop?.sig, next.desktop?.sig) && sameLook(prev.phone?.sig, next.phone?.sig)
  );
}

/**
 * What a capture stores, from the stored `fullPage` (or null) and the two
 * views (captureView): { fullPage, uploadImages, uploadLegacy }.
 *   both views taken, looks the same: the stored version stays (only
 *     `checkedAt` moves), nothing is uploaded.
 *   both views taken, changed or new: a new version `v` (the capture time).
 *   a view failed: the stored version, if any, stays with `lastError`;
 *     without one, the errors are recorded (the backfill tries again).
 * The old frames (hero.jpg, mobile.jpg) go up unless nothing changed.
 */
export function nextFullPage(prev, { desktopView, phoneView, pageText, at }) {
  const iso = at.toISOString();
  const th = textHash(pageText);
  if (desktopView.ok && phoneView.ok) {
    const next = { v: versionOf(at), at: iso, textHash: th, desktop: desktopView.meta, phone: phoneView.meta };
    if (unchanged(prev, next)) return { fullPage: { ...prev, checkedAt: iso }, uploadImages: false, uploadLegacy: false };
    return { fullPage: next, uploadImages: true, uploadLegacy: true };
  }
  const errors = { at: iso, desktop: desktopView.meta, phone: phoneView.meta };
  if (prev?.v) return { fullPage: { ...prev, lastError: errors }, uploadImages: false, uploadLegacy: true };
  return { fullPage: { ...errors, tries: nextTries(prev) }, uploadImages: false, uploadLegacy: true };
}

/** Whether a stored `fullPage` has both tall images. */
export const fullPageComplete = (fp) => Boolean(fp && fp.v && fp.desktop?.bytes > 0 && fp.phone?.bytes > 0);

/**
 * Waits for a freshly loaded page's first screen to hold still (preloaders,
 * typing and intro animations), the way the capture waits for its hero:
 * two quiet polls in a row, at most `polls` polls. Returns whether it settled.
 */
export async function settleFirstScreen(page, { intervalMs = 1500, polls = 8, diff } = {}) {
  const pngDiff = diff ?? (await import("./png-diff.mjs")).pngDiff;
  let prev = await page.screenshot({ type: "png" });
  let quiet = 0;
  for (let i = 0; i < polls && quiet < 2; i++) {
    await page.waitForTimeout(intervalMs);
    const cur = await page.screenshot({ type: "png" });
    quiet = pngDiff(prev, cur) < 0.01 ? quiet + 1 : 0;
    prev = cur;
  }
  return quiet >= 2;
}

// ---------------------------------------------------------------------------
// Backfill bookkeeping (pipeline/fullpage-backfill.mjs)
// ---------------------------------------------------------------------------

/** A site whose images failed is tried again this many times in all... */
export const FULL_PAGE_MAX_TRIES = 3;
/** ...at least this far apart. */
export const FULL_PAGE_RETRY_DAYS = 7;

// The stored fullPage of a row, or NULL when meta is missing or not JSON.
const FP = (p) => `CASE WHEN json_valid(${p}.meta) THEN json_extract(${p}.meta, '$.fullPage') END`;

/**
 * Listed, live, captured sites without both tall images, at most `limit`:
 * never tried first (newest capture first), then failed ones whose last
 * try is FULL_PAGE_RETRY_DAYS old, until FULL_PAGE_MAX_TRIES. A try the
 * capture made counts as one. `active` is pipeline/roster.mjs ACTIVE.
 */
export async function fullPageDue(db, { limit, active, now = Date.now() }) {
  const fp = FP("p");
  const before = new Date(now - FULL_PAGE_RETRY_DAYS * 86400000).toISOString();
  const res = await db.execute({
    sql: `SELECT p.url, p.name, p.shot_key, ${fp} AS full_page FROM portfolios p
          WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${active("p")}
            AND (${fp} IS NULL OR (
              NOT (json_extract(${fp}, '$.v') IS NOT NULL AND COALESCE(json_extract(${fp}, '$.desktop.bytes'), 0) > 0 AND COALESCE(json_extract(${fp}, '$.phone.bytes'), 0) > 0)
              AND COALESCE(json_extract(${fp}, '$.tries'), 1) < ?
              AND COALESCE(json_extract(${fp}, '$.at'), '') < ?))
          ORDER BY (${fp} IS NOT NULL), p.captured_at DESC, p.url
          LIMIT ?`,
    args: [FULL_PAGE_MAX_TRIES, before, limit],
  });
  return res.rows.map((r) => ({
    url: String(r.url),
    name: r.name == null ? null : String(r.name),
    shotKey: String(r.shot_key),
    fullPage: r.full_page == null ? null : JSON.parse(String(r.full_page)),
  }));
}

/** How many tries a new result counts, given the stored one. */
export const nextTries = (prev) => (prev ? Number(prev.tries ?? 1) : 0) + 1;

/**
 * Stores a backfill's result in the row's meta (`fullPage`), leaving every
 * other field, captured_at (the old frames' version) and the page
 * fingerprint as they were. Only while the row still has the same shot_key.
 */
export async function recordFullPage(db, { url, shotKey, fullPage }) {
  const r = await db.execute({
    sql: `UPDATE portfolios SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.fullPage', json(?))
          WHERE url = ? AND shot_key = ?`,
    args: [JSON.stringify(fullPage), url, shotKey],
  });
  return r.rowsAffected;
}
