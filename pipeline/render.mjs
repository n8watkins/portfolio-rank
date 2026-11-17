// A real-browser page load, shared by the health check (the second opinion
// for single-page apps, JavaScript redirects and cold starts) and the AI
// grade (page text and facts for client-rendered sites captured before
// rubric v2). Playwright is imported only when a page is first rendered.
import { chromeUA, readRenderedPage } from "./gate.mjs";

/**
 * The browser's own User-Agent, as a visitor's Chrome sends it: the version
 * of the Chromium that Playwright installed (browser.version(), "158.0.8127.18"),
 * never a pinned string, so it stays current with every Playwright update and
 * matches the version the browser's client hints report. Headless Chromium
 * says "HeadlessChrome", which bot filters block on sight; a visitor's says
 * "Chrome". Independent of the plain request's User-Agent (gate.mjs UA, worked
 * out from the date), so one stale string can't fail both opinions at once.
 */
export function browserUserAgent(version) {
  const major = Number.parseInt(String(version ?? ""), 10);
  return Number.isFinite(major) && major > 0 ? chromeUA(major) : chromeUA();
}

/**
 * A lazy renderer. render(url) resolves to { status, finalUrl, title, text,
 * media, html } or throws; close() shuts the browser if one was started.
 * The page counts as loaded once its HTML has arrived and parsed
 * (domcontentloaded); then it gets until `timeoutMs` for the load event and a
 * few seconds of network quiet, but a slow image or script never turns a
 * page that answered into an error.
 */
export function createRenderer({ viewport = { width: 1280, height: 800 }, timeoutMs = 30000 } = {}) {
  let browser = null;
  let starting = null;
  let userAgent = null;
  const start = async () => {
    if (browser) return browser;
    starting ??= import("playwright").then(({ chromium }) => chromium.launch());
    browser = await starting;
    userAgent ??= browserUserAgent(browser.version());
    return browser;
  };
  return {
    async render(url) {
      const b = await start();
      // Certificate errors stay errors: a visitor would see a warning page.
      const ctx = await b.newContext({ userAgent, viewport });
      try {
        const page = await ctx.newPage();
        const began = Date.now();
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForLoadState("load", { timeout: Math.max(1000, timeoutMs - (Date.now() - began)) }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return {
          status: res?.status() ?? 0,
          finalUrl: page.url(),
          title: await page.title().catch(() => ""),
          ...(await page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false, html: "" }))),
        };
      } finally {
        await ctx.close().catch(() => {});
      }
    },
    async close() {
      if (starting) await (await starting.catch(() => null))?.close().catch(() => {});
      browser = null;
      starting = null;
    },
  };
}
