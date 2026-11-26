// One visit to a site that gives both tall images, their first screens and
// the page text, without storing anything: the local entry point for
// experiments and the backfill (pipeline/fullpage-backfill.mjs), and the
// same image path the nightly capture takes (pipeline/capture.mjs, which
// adds its diagnostics, facts and storage around it).
//
//   const r = await captureOnce(browser, "https://example.dev");
//   r.desktop / r.phone   pipeline/fullpage.mjs captureView results:
//     { ok: true, files: { tall, thumb, crop, sig }, meta } or { ok: false, meta: { error } }
//     files.tall   AVIF, 1440 (390) wide, at most 4,000 (6,000) px tall
//     files.thumb  AVIF, 480 (240) wide: the first screen scaled
//     files.crop   JPEG 75, the first screen, 1440 x 900 (390 x 844):
//                  byte for byte what the grade reads as hero.jpg / mobile.jpg
//     meta.outline [{ level, text, y }]: h1 to h3 and their row on the tall image
//   r.text      the page's visible text, normalised as the grade gets it
//   r.finalUrl  where the page ended up after redirects
//
// One load at 1440 x 900, idle network (up to 8 s), the splash gate and the
// dialog passes (pipeline/splash.mjs), a still first screen (up to 12 s),
// then captureView: one scroll through the page (or the element it scrolls
// inside), back to the top, the tall image stitched per screenful, all
// within about 15 s a view, encoding included (fullpage.mjs VIEW_BUDGET_MS).
// The phone view is the same page resized to 390 x 844, never a second
// visit (as pipeline/capture.mjs narrowView takes it): a reflow, a still
// first screen (up to 6 s), then its tall image.
import { readRenderedPage, UA } from "./gate.mjs";
import { normalizePageText } from "./rubric.mjs";
import { passModal, passSplashGate } from "./splash.mjs";
import { FRAMES, captureViewAsSeen, settleFirstScreen } from "./fullpage.mjs";

/**
 * Both views of one site in a fresh browser context (closed before it
 * returns). Never throws for the site itself: a view that fails is
 * { ok: false, meta: { error } }. `budgetMs` overrides the per-view time.
 */
export async function captureOnce(browser, url, { userAgent = UA, budgetMs } = {}) {
  const ctx = await browser.newContext({ viewport: { width: FRAMES.desktop.width, height: FRAMES.desktop.viewportHeight }, userAgent, ignoreHTTPSErrors: true });
  const failed = (e) => ({ ok: false, meta: { error: String(e?.message ?? e).split("\n")[0].slice(0, 200) } });
  const out = { desktop: null, phone: null, text: "", finalUrl: url, splash: null, modal: null };
  try {
    let page = null;
    try {
      page = await ctx.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      out.splash = await passSplashGate(page).catch(() => null);
      out.modal = await passModal(page).catch(() => null);
      await settleFirstScreen(page).catch(() => false);
      out.finalUrl = page.url();
      out.text = normalizePageText((await page.evaluate(readRenderedPage).catch(() => ({ text: "" }))).text);
      out.desktop = await captureViewAsSeen(page, "desktop", { budgetMs });
    } catch (e) {
      out.desktop = failed(e);
    }
    try {
      if (!out.desktop?.ok) throw new Error("no page to resize: the desktop view failed");
      await page.setViewportSize({ width: FRAMES.phone.width, height: FRAMES.phone.viewportHeight });
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      await settleFirstScreen(page, { polls: 4 }).catch(() => false);
      out.phone = await captureViewAsSeen(page, "phone", { budgetMs });
    } catch (e) {
      out.phone = failed(e);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}
