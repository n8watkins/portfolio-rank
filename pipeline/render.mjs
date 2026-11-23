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
 * and the most it waits for a page that has text.
 */
export const SETTLE_POLL_MS = 500;
export const SETTLE_QUIET_MS = 2000;
export const SETTLE_MAX_MS = 10000;
/**
 * Below this many characters of visible text (about 60 words) a page is thin:
 * an intro screen, a loader or a page still drawing, not yet the site. Text
 * that holds still on a thin page is no sign the page is finished, so it is
 * watched up to SETTLE_THIN_MAX_MS. On 2026-11-23 four listed sites showed
 * only an intro for 5 to 11 seconds after their HTML arrived (56 to 168
 * characters: www.abhishekworks.com "There's a new Dev in town. Meet
 * Abhishek!", thesoham2203.vercel.app, www.sachingoyal.me,
 * ujjwalsoni-portfolio.vercel.app), then 800 to 33,000 characters.
 */
export const SETTLE_THIN_CHARS = 400;
/** The most settleText waits on a page that has been thin: the overall limit of the wait. */
export const SETTLE_THIN_MAX_MS = 15000;

/**
 * Runs in the page (page.evaluate): scrolls one screen further down, unless
 * the bottom is already in view, and returns the visible text's length. Only
 * scrolling: nothing is clicked, pressed or submitted, so an intro that waits
 * for a press ("Press the button to begin.") stays as it is.
 */
export function scrollAndMeasure() {
  const root = document.scrollingElement ?? document.documentElement;
  if (root && window.innerHeight + window.scrollY < root.scrollHeight - 2) window.scrollBy(0, window.innerHeight);
  return (document.body?.innerText ?? "").trim().length;
}

/**
 * Waits until the page's visible text has rendered and stopped growing: its
 * length, sampled every `pollMs`, unchanged for `quietMs`, at most `maxMs` in
 * all. A thin page (under `thinChars` characters) is not finished however
 * long it holds still: it is watched until it grows past that, and once it
 * has been thin the limit is `thinMaxMs`. Each sample scrolls one screen
 * down (scrollAndMeasure), so content that loads as it scrolls into view
 * appears too. In the facts audit (2026-11-21,
 * scripts/experiments/facts-audit/) 13 of 70 listed sites had under half
 * their words, most of them none, at network idle plus a second, the point
 * this renderer used to read at; the list's capture reads much later and
 * was not short. A page already rendered and still costs `quietMs`; a page
 * that stays thin (or never shows text) costs `thinMaxMs`; one that never
 * stops changing costs `maxMs`. Returns { ms, grew }: the time spent and how
 * many characters appeared meanwhile. A caller that sets its own `maxMs`
 * and no `thinMaxMs` gets that one limit for every page.
 * @param {import("playwright").Page} page
 */
export async function settleText(page, opts = {}) {
  const { pollMs = SETTLE_POLL_MS, quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS, thinChars = SETTLE_THIN_CHARS } = opts;
  const thinMaxMs = opts.thinMaxMs ?? ("maxMs" in opts ? maxMs : SETTLE_THIN_MAX_MS);
  // -1 while the page cannot be read (navigating); null when it answers no number at all (nothing to wait for).
  const len = async () => {
    const n = await page.evaluate(scrollAndMeasure).catch(() => -1);
    return typeof n === "number" ? n : null;
  };
  const t0 = Date.now();
  const first = await len();
  if (first == null) return { ms: 0, grew: 0 };
  let last = first;
  let stillSince = t0;
  let wasThin = first < thinChars;
  const limit = () => (wasThin ? Math.max(maxMs, thinMaxMs) : maxMs);
  while (Date.now() - t0 < limit() && (last < thinChars || Date.now() - stillSince < quietMs)) {
    await page.waitForTimeout(pollMs);
    const n = await len();
    if (n == null) break;
    if (n !== last) stillSince = Date.now();
    last = n;
    if (n < thinChars) wasThin = true;
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
 * still (settleText: 10 seconds at most, 15 for a page that has been thin,
 * scrolling one screen per sample), but a slow image or script never
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
