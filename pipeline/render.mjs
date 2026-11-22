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
 * How often settleText samples the page's text, how long it must hold still,
 * the most it waits, and how much text counts as "the page has rendered".
 */
export const SETTLE_POLL_MS = 500;
export const SETTLE_QUIET_MS = 2000;
export const SETTLE_MAX_MS = 10000;
export const SETTLE_MIN_CHARS = 30;

/**
 * Waits until the page's visible text has rendered and stopped growing: at
 * least `minChars` characters, its length sampled every `pollMs` unchanged
 * for `quietMs`, at most `maxMs` in all. In the facts audit (2026-11-21,
 * scripts/experiments/facts-audit/) 13 of 70 listed sites had under half
 * their words, most of them none, at network idle plus a second, the point
 * this renderer used to read at; the list's capture reads much later and
 * was not short. A page already rendered and still costs `quietMs`; a page
 * that never shows text costs `maxMs`. Returns { ms, grew }: the time spent
 * and how many characters appeared meanwhile.
 * @param {import("playwright").Page} page
 */
export async function settleText(page, { pollMs = SETTLE_POLL_MS, quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS, minChars = SETTLE_MIN_CHARS } = {}) {
  // -1 while the page cannot be read (navigating); null when it answers no number at all (nothing to wait for).
  const len = async () => {
    const n = await page.evaluate(() => (document.body?.innerText ?? "").trim().length).catch(() => -1);
    return typeof n === "number" ? n : null;
  };
  const t0 = Date.now();
  const first = await len();
  if (first == null) return { ms: 0, grew: 0 };
  let last = first;
  let stillSince = t0;
  while (Date.now() - t0 < maxMs && (last < minChars || Date.now() - stillSince < quietMs)) {
    await page.waitForTimeout(pollMs);
    const n = await len();
    if (n == null) break;
    if (n !== last) stillSince = Date.now();
    last = n;
  }
  return { ms: Date.now() - t0, grew: Math.max(0, last - first) };
}

/** The browser could not start (Playwright's Chromium missing or failing to launch): says nothing about a site. */
export class BrowserUnavailableError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(`the browser could not start: ${String(/** @type {any} */ (cause)?.message ?? cause).split("\n")[0].slice(0, 160)}`);
    this.name = "BrowserUnavailableError";
    this.cause = cause;
  }
}

/**
 * A lazy renderer. render(url) resolves to { status, finalUrl, title, text,
 * media, html } or throws; close() shuts the browser if one was started.
 * A failed launch throws BrowserUnavailableError and is not kept: the next
 * render tries to launch again.
 * The page counts as loaded once its HTML has arrived and parsed
 * (domcontentloaded); then it gets until `timeoutMs` for the load event and a
 * few seconds of network quiet, then until its text has rendered and holds
 * still (settleText, 10 seconds at most), but a slow image or script never
 * turns a page that answered into an error.
 */
export function createRenderer({
  viewport = { width: 1280, height: 800 },
  timeoutMs = 30000,
  launch = () => import("playwright").then(({ chromium }) => chromium.launch()),
} = {}) {
  let browser = null;
  let starting = null;
  let userAgent = null;
  const start = async () => {
    if (browser) return browser;
    starting ??= launch();
    try {
      browser = await starting;
    } catch (e) {
      starting = null;
      throw new BrowserUnavailableError(e);
    }
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
        // Client-rendered pages often have no text yet at network idle: read once it has rendered and holds still.
        await settleText(page);
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
