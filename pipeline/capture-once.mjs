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
// Per view: load, idle network (up to 8 s), the splash gate and the dialog
// passes (pipeline/splash.mjs), a still first screen (up to 12 s), then
// captureView: one scroll through the page (or the element it scrolls
// inside), back to the top, the tall image stitched per screenful, all
// within about 15 s a view, encoding included (fullpage.mjs VIEW_BUDGET_MS).
import { readRenderedPage, UA } from "./gate.mjs";
import { normalizePageText } from "./rubric.mjs";
import { passModal, passSplashGate } from "./splash.mjs";
import { FRAMES, captureView, settleFirstScreen } from "./fullpage.mjs";

/** Opens one view of the site in `ctx` and makes its tall image; returns { result, page }. */
async function openView(ctx, url, name) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: FRAMES[name].width, height: FRAMES[name].viewportHeight });
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const splash = await passSplashGate(page).catch(() => null);
  const modal = await passModal(page).catch(() => null);
  await settleFirstScreen(page).catch(() => false);
  return { page, splash, modal };
}

/**
 * Both views of one site in a fresh browser context (closed before it
 * returns). Never throws for the site itself: a view that fails is
 * { ok: false, meta: { error } }. `budgetMs` overrides the per-view time.
 */
export async function captureOnce(browser, url, { userAgent = UA, budgetMs } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent, ignoreHTTPSErrors: true });
  const failed = (e) => ({ ok: false, meta: { error: String(e?.message ?? e).split("\n")[0].slice(0, 200) } });
  const out = { desktop: null, phone: null, text: "", finalUrl: url, splash: null, modal: null };
  try {
    try {
      const d = await openView(ctx, url, "desktop");
      out.finalUrl = d.page.url();
      out.splash = d.splash;
      out.modal = d.modal;
      out.text = normalizePageText((await d.page.evaluate(readRenderedPage).catch(() => ({ text: "" }))).text);
      out.desktop = await captureView(d.page, "desktop", { budgetMs });
      await d.page.close().catch(() => {});
    } catch (e) {
      out.desktop = failed(e);
    }
    try {
      const p = await openView(ctx, url, "phone");
      out.phone = await captureView(p.page, "phone", { budgetMs });
    } catch (e) {
      out.phone = failed(e);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}
