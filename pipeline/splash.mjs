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

// Modals on load (owner, 2026-11-13): a dialog over a page that is already
// there ("Choose a Theme" with nine options and "Continue with ChatGPT"
// over 216 words of page), which the gate check never sees because the
// page under it has plenty of text. When a visible dialog is on top after
// load (role=dialog or aria-modal or an open <dialog> covering at least
// MODAL_MIN_DIALOG of the screen, or a fixed overlay covering more than
// MODAL_MIN_OVERLAY of it), the capture does what a visitor does to get the
// site's default view: it clicks the dialog's primary button (Continue,
// Enter, Start, Get started, else Close), or presses Escape when there is
// none, then checks once more. A cookie bar is too small to count.
export const MODAL_MIN_DIALOG = 0.2;
export const MODAL_MIN_OVERLAY = 0.5;
export const MODAL_WAIT_MS = 2500;

/**
 * In the browser: the dialog on top, or null. Marks it data-pr-modal and its
 * primary button data-pr-modal-go; returns { kind, area, button } (button:
 * the label, or null when Escape is the way out).
 */
function findModal([minDialog, minOverlay]) {
  for (const el of document.querySelectorAll("[data-pr-modal], [data-pr-modal-go]")) {
    el.removeAttribute("data-pr-modal");
    el.removeAttribute("data-pr-modal-go");
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const area = (r) => (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
  const shown = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) >= 0.05;
  };
  // On top: the element at the dialog's centre belongs to it.
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max((r.left + r.right) / 2, 1), vw - 1);
    const y = Math.min(Math.max((r.top + r.bottom) / 2, 1), vh - 1);
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (el === hit || el.contains(hit)));
  };
  const words = (t) => (String(t ?? "").match(/\S+/g) ?? []).length;
  let found = null;
  for (const el of document.querySelectorAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]")) {
    if (shown(el) && area(el.getBoundingClientRect()) >= minDialog && onTop(el)) {
      found = { el, kind: "dialog" };
      break;
    }
  }
  if (!found) {
    // A fixed overlay: covers most of the screen, sits on top, and hides a page with more text than it has itself.
    const all = words(document.body?.innerText);
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed" || !shown(el)) continue;
      if (area(el.getBoundingClientRect()) <= minOverlay || !onTop(el)) continue;
      const own = words(el.innerText);
      if (own === 0 || all - own < 40) continue;
      found = { el, kind: "overlay" };
      break;
    }
  }
  if (!found) return null;
  const PRIMARY = /^(continue|enter|start|get started|let'?s go|explore)\b/i;
  const CLOSE = /^(close|dismiss|skip|×|✕|x)$/i;
  const clickables = [...found.el.querySelectorAll("button, a, [role=button]")].filter(shown);
  const label = (b) => (b.innerText || b.getAttribute("aria-label") || b.getAttribute("title") || "").replace(/\s+/g, " ").trim();
  const go = clickables.find((b) => PRIMARY.test(label(b))) ?? clickables.find((b) => CLOSE.test(label(b)));
  found.el.setAttribute("data-pr-modal", "1");
  if (go) go.setAttribute("data-pr-modal-go", "1");
  return { kind: found.kind, area: Math.round(area(found.el.getBoundingClientRect()) * 100) / 100, button: go ? label(go).slice(0, 60) : null };
}

/**
 * Closes a dialog on top of a loaded Playwright page, if there is one: its
 * primary button, else Escape; then checks once more (and presses Escape
 * when a dialog is still there). Returns null when there was no dialog,
 * else { kind, button, how: ("button" | "escape")[], passed, left? }.
 * @param {import("playwright").Page} page
 */
export async function passModal(page, { waitMs = MODAL_WAIT_MS } = {}) {
  const args = [MODAL_MIN_DIALOG, MODAL_MIN_OVERLAY];
  const first = await page.evaluate(findModal, args).catch(() => null);
  if (!first) return null;
  const start = page.url();
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const how = [];
  let found = first;
  for (let i = 0; i < 2 && found; i++) {
    const box = found.button && i === 0 ? await page.locator("[data-pr-modal-go]").first().boundingBox().catch(() => null) : null;
    if (box) {
      await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)).catch(() => {});
      how.push("button");
    } else {
      await page.keyboard.press("Escape").catch(() => {});
      how.push("escape");
    }
    await page.waitForTimeout(waitMs);
    // A button that left the site (a download page, a social profile) is undone.
    if (host(page.url()) !== host(start)) {
      await page.goto(start, { waitUntil: "load", timeout: 30000 }).catch(() => {});
      return { kind: first.kind, button: first.button, how, passed: false, left: true };
    }
    found = await page.evaluate(findModal, args).catch(() => null);
  }
  return { kind: first.kind, button: first.button, how, passed: !found };
}
