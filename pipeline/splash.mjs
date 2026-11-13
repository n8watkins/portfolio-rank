// Splash gates (owner, 2026-11-13): some portfolios open on a screen that
// asks for a click first ("CLICK TO CONTINUE", "Enter", "Press any key",
// "Skip intro", or a loader stuck at 100%), so the capture saw an empty
// page and the grade judged that. When the first screen has very little
// text and shows such a gate, the capture clicks it (the button or link
// with that text, else the page's centre), waits up to GATE_WAIT_MS for
// content, and goes on as normal. At most MAX_GATE_CLICKS clicks, so a page
// that keeps asking never loops. The capture records what it passed in its
// meta (pipeline/capture.mjs, meta.splash).

/** A first screen with fewer words than this can be a gate. */
export const GATE_MAX_WORDS = 40;
export const MAX_GATE_CLICKS = 2;
export const GATE_WAIT_MS = 3000;
/** How long a loader still counting up ("72 %") is given to reach 100% before the gate is clicked. */
export const LOADER_WAIT_MS = 8000;

// Gate wording, matched on whole words in the visible text (lower case).
// Plain words ("enter", "start", "continue") also appear on short real
// pages ("Start a project"), so they count only on a nearly empty screen
// (WEAK_MAX_WORDS) and only as an element's whole text.
const STRONG = ["click to continue", "click to enter", "tap to continue", "tap to enter", "press any key", "press enter", "skip intro", "enter site", "enter the site"];
const WEAK = ["enter", "start", "continue"];
export const WEAK_MAX_WORDS = 10;

/**
 * Whether a first screen is a gate, from its visible text: { gate: false }
 * or { gate: true, phrase } (phrase null for a loader stuck at 100%).
 * @param {string} text
 */
export function detectGate(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const words = t ? t.split(" ").length : 0;
  if (words === 0 || words >= GATE_MAX_WORDS) return { gate: false, words };
  const has = (p) => new RegExp(`(^|[^a-z])${p.replace(/ /g, "\\s+")}([^a-z]|$)`).test(t);
  for (const p of STRONG) if (has(p)) return { gate: true, phrase: p, exact: false, words };
  if (words <= WEAK_MAX_WORDS) for (const p of WEAK) if (has(p)) return { gate: true, phrase: p, exact: true, words };
  if (/(^|\s)100\s?%(\s|$)/.test(t) && words <= 6) return { gate: true, phrase: null, exact: false, words };
  return { gate: false, words };
}

/** The page's visible text (in the browser). */
const visibleText = () => document.body?.innerText ?? "";

/**
 * In the browser: the visible clickable element whose own text is the
 * phrase (a button, a link, or anything with role=button or a pointer
 * cursor), marked with data-pr-gate so Playwright can click it; true when
 * one was found.
 */
function markGateTarget([phrase, exact]) {
  const want = phrase.toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const candidates = [...document.querySelectorAll("button, a, [role=button], [onclick], div, span, p, h1, h2, h3")].filter((el) => {
    const own = (el.innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    return own && (exact ? own.replace(/[^a-z ]/g, "").trim() === want : own.length <= want.length + 40 && own.includes(want)) && visible(el);
  });
  // The smallest match (the button itself, not the section around it), clickable ones first.
  candidates.sort((a, b) => {
    const click = (el) => (el.matches("button, a, [role=button], [onclick]") || getComputedStyle(el).cursor === "pointer" ? 0 : 1);
    return click(a) - click(b) || a.innerText.length - b.innerText.length;
  });
  if (!candidates[0]) return false;
  candidates[0].setAttribute("data-pr-gate", "1");
  return true;
}

const wordsOf = (t) => (String(t ?? "").replace(/\s+/g, " ").trim() ? String(t).replace(/\s+/g, " ").trim().split(" ").length : 0);

/**
 * Passes a splash gate on a loaded Playwright page, if there is one.
 * Returns null when the first screen isn't a gate, else
 * { passed, clicks, phrase, how: ("element" | "centre" | "key")[], words }.
 * @param {import("playwright").Page} page
 */
export async function passSplashGate(page, { maxClicks = MAX_GATE_CLICKS, waitMs = GATE_WAIT_MS } = {}) {
  let text = await page.evaluate(visibleText).catch(() => "");
  let found = detectGate(text);
  if (!found.gate) return null;
  const first = found;
  const start = page.url();
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const how = [];
  let clicks = 0;
  while (found.gate && clicks < maxClicks) {
    // A loader still counting ("72 %") isn't ready to be clicked: wait for it to reach 100 or go.
    const counting = (t) => [...String(t).matchAll(/(^|[^\d])(\d{1,2})\s?%/g)].length > 0 && !/(^|[^\d])100\s?%/.test(String(t));
    for (const until = Date.now() + LOADER_WAIT_MS; counting(text) && Date.now() < until; ) {
      await page.waitForTimeout(250);
      text = await page.evaluate(visibleText).catch(() => text);
    }
    await page.waitForTimeout(300);
    const marked = found.phrase ? await page.evaluate(markGateTarget, [found.phrase, found.exact]).catch(() => false) : false;
    // A plain word ("Start") is clicked only on its own button or link, never the page centre.
    if (!marked && found.exact) break;
    clicks++;
    if (marked) {
      // A real click at the label's position, as a person makes it: gates often draw the
      // label with pointer-events: none under a full-screen layer that takes the click.
      const box = await page.locator("[data-pr-gate]").boundingBox().catch(() => null);
      if (box) await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)).catch(() => {});
      how.push("element");
    } else {
      const v = page.viewportSize() ?? { width: 1440, height: 900 };
      await page.mouse.click(Math.round(v.width / 2), Math.round(v.height / 2)).catch(() => {});
      how.push("centre");
    }
    if (found.phrase === "press any key" || found.phrase === "press enter") {
      await page.keyboard.press("Enter").catch(() => {});
      how.push("key");
    }
    await page.evaluate(() => document.querySelector("[data-pr-gate]")?.removeAttribute("data-pr-gate")).catch(() => {});
    // Up to waitMs for content: more words than the gate had, or a page that navigated.
    const before = wordsOf(text);
    const until = Date.now() + waitMs;
    for (;;) {
      await page.waitForTimeout(250);
      text = await page.evaluate(visibleText).catch(() => "");
      if (wordsOf(text) > Math.max(before, GATE_MAX_WORDS / 2) || Date.now() >= until) break;
    }
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    // A click that left the site (a contact link, a social profile) is undone: the capture is of the portfolio.
    if (host(page.url()) !== host(start)) {
      await page.goto(start, { waitUntil: "load", timeout: 30000 }).catch(() => {});
      return { passed: false, clicks, phrase: first.phrase, how, left: true, words: { before: first.words, after: first.words } };
    }
    text = await page.evaluate(visibleText).catch(() => text);
    found = detectGate(text);
  }
  if (clicks === 0) return null;
  return { passed: !found.gate, clicks, phrase: first.phrase, how, words: { before: first.words, after: wordsOf(text) } };
}
