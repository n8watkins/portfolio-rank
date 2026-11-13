// Full-page screenshots, desktop and phone, for the report card's "see the
// whole page" preview (shown only with FULLPAGE_PREVIEW_ENABLED,
// lib/fullpage-flag.ts). Taken by the capture (pipeline/capture.mjs) after
// its own frames, and for sites captured before this existed by
// pipeline/fullpage-backfill.mjs.
//
//   full-desktop.webp  1440 wide, at most 6,000 px tall
//   full-phone.webp     390 wide, at most 8,000 px tall
//
// Lazy content: the page is scrolled through once, top to bottom, in steps
// (images with loading="lazy" and infinite lists load), within a time
// budget. Then the frame is stitched from one viewport screenshot per
// screenful (captureFullPage says why), each after a short wait for that
// screen's reveal effects and images. A page taller than the cap is cut at
// the cap and `cropped` says so. Playwright gives PNG; sharp (libvips)
// stitches the tiles and encodes WebP quality 75, which was 44% smaller
// than JPEG 75 at equal or better quality (PR #201).
//
// Nothing here is retried: a shot that fails or times out is recorded as an
// error in the site's meta, and pipeline/fullpage-backfill.mjs tries again a
// bounded number of times, a week apart.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { FULL_DESKTOP, FULL_PHONE } from "./shot-files.mjs";
import { pngDiff } from "./png-diff.mjs";

export const WEBP_QUALITY = 75;

/** The two frames: viewport width, file name and height cap. */
export const FULL_PAGE_FRAMES = {
  desktop: { file: FULL_DESKTOP, width: 1440, maxHeight: 6000 },
  phone: { file: FULL_PHONE, width: 390, maxHeight: 8000 },
};

export const FULL_PAGE_FILES = Object.values(FULL_PAGE_FRAMES).map((f) => f.file);

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

/**
 * Scrolls the page from top to bottom once (to the height cap at most) and
 * back to the top. Runs in the page; returns how far it got and whether it
 * stopped on the time budget.
 */
export async function scrollThrough(page, { maxHeight, pauseMs = SCROLL_PAUSE_MS, budgetMs = SCROLL_BUDGET_MS }) {
  const run = page.evaluate(
    async ({ maxHeight, pauseMs, budgetMs }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      const start = performance.now();
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      let y = 0;
      let outOfTime = false;
      for (;;) {
        const bottom = Math.min(height(), maxHeight) - window.innerHeight;
        if (y >= bottom) break;
        if (performance.now() - start > budgetMs) {
          outOfTime = true;
          break;
        }
        y = Math.min(y + step, bottom);
        window.scrollTo({ top: y, left: 0, behavior: "instant" });
        await sleep(pauseMs);
      }
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
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
 * unfinished ones above the height cap (a lazy image below it never starts).
 */
async function imagesLoaded(page, maxHeight, timeoutMs = IMAGES_WAIT_MS) {
  await page
    .evaluate(
      ({ maxHeight, timeoutMs }) =>
        Promise.race([
          Promise.all(
            [...document.images]
              .filter((img) => !img.complete && img.getBoundingClientRect().top + window.scrollY < maxHeight)
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
 * Waits for a freshly loaded page's first screen to hold still (preloaders,
 * typing and intro animations), the way the capture waits for its hero:
 * two quiet polls in a row, at most `polls` polls. An animated background
 * that never holds still just uses up the polls. The backfill needs this;
 * the capture's pages have settled already. Returns whether it settled.
 */
export async function settleFirstScreen(page, { intervalMs = 1500, polls = 8 } = {}) {
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

/** The rendered page's height in CSS pixels. */
export const pageHeightOf = (page) =>
  page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight));

/**
 * The height to capture: the page's own, at least one viewport (a page whose
 * content sits in its own scrolling box reports the viewport) and at most
 * the cap. `cropped` when the page is taller than the cap.
 */
export function shotHeight(pageHeight, viewportHeight, maxHeight) {
  const h = Math.max(Math.ceil(Number(pageHeight) || 0), viewportHeight);
  return { height: Math.min(h, maxHeight), cropped: h > maxHeight };
}

/** PNG to WebP at WEBP_QUALITY. Returns the bytes and their size. */
export async function toWebp(png) {
  const { data, info } = await sharp(png).webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: info.size };
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
 * One full-page frame of an open, loaded page whose viewport is already the
 * frame's width. Writes <dir>/<file> and returns what goes in the meta:
 * { width, height, pageHeight, cropped, bytes, ms }.
 *
 * Stitched from viewport screenshots, one per screenful from the top: many
 * portfolios show a section only while it is in view (scroll-linked
 * opacity, reveal animations that play back when scrolled away), so one
 * screenshot of the whole document leaves everything below the first
 * screen blank. Each tile shows the page the way a visitor scrolling there
 * sees it. If the page stops scrolling before the height (its content
 * scrolls inside its own box), the image ends where scrolling did.
 */
export async function captureFullPage(page, dir, frame) {
  const t = Date.now();
  const viewport = page.viewportSize() ?? { width: frame.width, height: 900 };
  const vh = viewport.height;
  const scroll = await scrollThrough(page, { maxHeight: frame.maxHeight });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await imagesLoaded(page, frame.maxHeight);
  const pageHeight = await pageHeightOf(page);
  const { height: wanted, cropped } = shotHeight(pageHeight, vh, frame.maxHeight);

  const tiles = [];
  let covered = 0;
  for (let y = 0; y < wanted; y += vh) {
    const actual = await page.evaluate((y) => {
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
      return Math.round(window.scrollY);
    }, y);
    await page.waitForTimeout(y === 0 ? SETTLE_MS : TILE_SETTLE_MS);
    await imagesLoaded(page, y + vh, TILE_IMAGES_WAIT_MS);
    const part = tileRows({ y, actual, viewportHeight: vh, height: wanted });
    if (!part) break;
    // Finite CSS animations and transitions (most reveal effects) are shown
    // at their end state.
    const png = await page.screenshot({ type: "png", animations: "disabled", timeout: SHOT_TIMEOUT_MS });
    const input = part.offset === 0 && part.rows === vh ? png : await sharp(png).extract({ left: 0, top: part.offset, width: viewport.width, height: part.rows }).toBuffer();
    tiles.push({ input, top: y, left: 0 });
    covered = y + part.rows;
    if (y === 0) await page.evaluate(HIDE_FIXED).catch(() => {});
  }
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
  if (!covered) throw new Error("no tile was taken");

  const { data, info } = await sharp({ create: { width: viewport.width, height: covered, channels: 3, background: "#ffffff" } })
    .composite(tiles)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  fs.writeFileSync(path.join(dir, frame.file), data);
  return {
    width: info.width,
    height: info.height,
    pageHeight: Math.round(pageHeight),
    cropped,
    bytes: info.size,
    ms: Date.now() - t,
    ...(covered < wanted ? { scrollStopped: true } : {}),
    ...(scroll.outOfTime ? { scrollCut: true } : {}),
  };
}

/**
 * Both frames, from a desktop page (1440 viewport) and a phone page (390
 * viewport), one after the other. Never throws: a frame that fails is
 * { error } and the other is still taken. Old files in `dir` are removed
 * first, so a failed frame never uploads a stale one. Returns the meta's
 * `fullPage`: { at, desktop, phone }.
 */
export async function captureFullPages({ desktop, phone }, dir, { now = () => new Date() } = {}) {
  for (const f of FULL_PAGE_FILES) fs.rmSync(path.join(dir, f), { force: true });
  const out = { at: now().toISOString() };
  for (const [name, page] of [["desktop", desktop], ["phone", phone]]) {
    try {
      out[name] = await captureFullPage(page, dir, FULL_PAGE_FRAMES[name]);
    } catch (e) {
      out[name] = { error: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
    }
  }
  return out;
}

/** Whether a stored `fullPage` has both frames. */
export const fullPageComplete = (fp) => Boolean(fp && fp.desktop?.bytes > 0 && fp.phone?.bytes > 0);

// ---------------------------------------------------------------------------
// Backfill bookkeeping (pipeline/fullpage-backfill.mjs)
// ---------------------------------------------------------------------------

/** A site whose frames failed is tried again this many times in all... */
export const FULL_PAGE_MAX_TRIES = 3;
/** ...at least this far apart. */
export const FULL_PAGE_RETRY_DAYS = 7;

// The stored fullPage of a row, or NULL when meta is missing or not JSON.
const FP = (p) => `CASE WHEN json_valid(${p}.meta) THEN json_extract(${p}.meta, '$.fullPage') END`;

/**
 * Listed, live, captured sites without both full-page frames, at most
 * `limit`: never tried first (newest capture first), then failed ones whose
 * last try is FULL_PAGE_RETRY_DAYS old, until FULL_PAGE_MAX_TRIES. A try the
 * capture made counts as one. `active` is pipeline/roster.mjs ACTIVE.
 */
export async function fullPageDue(db, { limit, active, now = Date.now() }) {
  const fp = FP("p");
  const before = new Date(now - FULL_PAGE_RETRY_DAYS * 86400000).toISOString();
  const res = await db.execute({
    sql: `SELECT p.url, p.name, p.shot_key, ${fp} AS full_page FROM portfolios p
          WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${active("p")}
            AND (${fp} IS NULL OR (
              NOT (COALESCE(json_extract(${fp}, '$.desktop.bytes'), 0) > 0 AND COALESCE(json_extract(${fp}, '$.phone.bytes'), 0) > 0)
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
 * other field, captured_at (the hero's version) and the page fingerprint as
 * they were. Only while the row still has the same shot_key.
 */
export async function recordFullPage(db, { url, shotKey, fullPage }) {
  const r = await db.execute({
    sql: `UPDATE portfolios SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.fullPage', json(?))
          WHERE url = ? AND shot_key = ?`,
    args: [JSON.stringify(fullPage), url, shotKey],
  });
  return r.rowsAffected;
}
