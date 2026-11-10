// A real-browser page load, shared by the health check (the second opinion
// for single-page apps, JavaScript redirects and cold starts) and the AI
// grade (page text and facts for client-rendered sites captured before
// rubric v2). Playwright is imported only when a page is first rendered.
import { readRenderedPage, UA } from "./gate.mjs";

/**
 * A lazy renderer. render(url) resolves to { status, finalUrl, title, text,
 * media, html } or throws; close() shuts the browser if one was started.
 */
export function createRenderer({ viewport = { width: 1280, height: 800 }, timeoutMs = 30000 } = {}) {
  let browser = null;
  let starting = null;
  const start = async () => {
    if (browser) return browser;
    starting ??= import("playwright").then(({ chromium }) => chromium.launch());
    browser = await starting;
    return browser;
  };
  return {
    async render(url) {
      const b = await start();
      // Certificate errors stay errors: a visitor would see a warning page.
      const ctx = await b.newContext({ userAgent: UA, viewport });
      try {
        const page = await ctx.newPage();
        const res = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
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
