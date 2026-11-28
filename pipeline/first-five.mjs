// The first five seconds (facts.first_five): what a visitor sees on the first
// screen, with no scrolling and nothing pressed, five seconds after the page
// starts loading, on a phone over a typical mobile connection and on a desktop
// over a fast one. The redesigned profile shows it (lib/profile-next/report.mjs
// firstFiveCard); nothing grades or ranks by it.
//
// Two readings per view, each of the first screen only:
//   at5    five seconds after the navigation started (AT_MS)
//   later  the capture's own settled view of the site, after its waits and
//          after any gate, dialog or picker was passed as a visitor would
// and from them:
//   biggest  the biggest text on the screen (the largest font size), quoted
//   nameHit  the part of the listed name found on the screen, or null
//   way      the text of a visible link or button that reaches the person or
//            shows the work (contact, email, LinkedIn, projects, work...), or null
//   words    how many words the screen shows
//   intro    at five seconds the screen was still an intro or still loading
//            (introAt5): nothing readable yet, or a small part of what the
//            settled page shows on the same screen
//
// Desktop is read during the capture's own visit (pipeline/capture.mjs
// captureOnce): a timer reads the screen five seconds after the navigation
// started, and the capture presses nothing until it has. Mobile needs a load
// of its own, throttled as Lighthouse throttles a phone (MOBILE), so it is a
// second, separate visit in a fresh browser context, made only after the
// capture's visit is over and its page closed (readMobileFirstFive): a site
// whose protection answers a repeat visit with a bot check then only loses
// this reading ("not measured", with the reason), never its capture. The
// mobile visit is bounded (MOBILE_LIMIT_MS) and skipped when the capture's own
// time limit is too near (MOBILE_MIN_LEFT_MS).
//
// Every failure is a reading stored as not measured with its reason; nothing
// here throws into the capture.

/** The version of the reading (facts.first_five.v); scripts/remeasure-shard.mjs fills it in where it is missing. */
export const FIRST_FIVE_VERSION = 1;
/** When the screen is read: five seconds after the navigation started. */
export const AT_MS = 5000;
/** A reading that came back later than this (a main thread too busy to answer) is not a five-second reading. */
export const LATE_MS = 7000;
/** The longest one reading of the screen may take. */
export const READ_LIMIT_MS = 2000;
/** The longest the mobile visit may take, reading and closing included. */
export const MOBILE_LIMIT_MS = 15000;
/** The mobile visit is made only when at least this much of the capture's time limit is left. */
export const MOBILE_MIN_LEFT_MS = 90000;
/** A settled screen with at least this many words is a page, not an intro. */
export const READY_WORDS = 20;
/** The biggest text is quoted up to this many characters. */
export const BIGGEST_MAX = 80;

/**
 * The phone, as Lighthouse's mobile run emulates it (its "slow 4G" devtools
 * throttling and its Moto G Power screen): 412 x 823 at 1.75x, 150 ms of
 * round trip x 3.75 = 562.5 ms of latency, 1.6 Mbps x 0.9 = 1474.56 Kbps down,
 * 750 Kbps x 0.9 = 675 Kbps up, and the CPU four times slower.
 */
export const MOBILE = {
  width: 412,
  height: 823,
  scale: 1.75,
  latencyMs: 562.5,
  downKbps: 1474.56,
  upKbps: 675,
  cpuSlowdown: 4,
};
export const MOBILE_APPLIED = `${MOBILE.width}x${MOBILE.height} at ${MOBILE.scale}x; ${MOBILE.latencyMs} ms latency, ${MOBILE.downKbps} Kbps down, ${MOBILE.upKbps} Kbps up; CPU ${MOBILE.cpuSlowdown}x slower`;
/** The desktop view's description, for the capture's viewport. */
export const desktopApplied = ({ width, height }) => `${width}x${height} at 1x; no throttling`;

/** A phone browser's User-Agent for the mobile visit (Chrome on Android, the major version the capture uses). */
export const mobileUA = (desktopUA) => {
  const major = /Chrome\/(\d+)/.exec(String(desktopUA))?.[1] ?? "140";
  return `Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
};

/**
 * Runs in the page (page.evaluate): the first screen as a visitor sees it,
 * with no scrolling. Only text and controls inside the viewport count, and only
 * what is drawn (not hidden, not fully transparent). Returns { words, biggest,
 * biggestPx, text, controls }: `text` is the screen's words in order (capped),
 * `controls` the visible links and buttons ({ text, href }).
 */
export function readFirstScreen() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const onScreen = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W;
  const drawn = (el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    // Text drawn in a fully transparent colour (a reveal not yet run) is not seen.
    if (/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(st.color) && !/text/.test(st.backgroundClip || st.webkitBackgroundClip || "")) return false;
    return true;
  };
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  // The box each ancestor clips its content to (overflow other than visible, a clip or a clip-path), or null.
  const clipBoxes = new Map();
  const clipBoxOf = (el) => {
    if (clipBoxes.has(el)) return clipBoxes.get(el);
    const st = getComputedStyle(el);
    const clips = (st.overflowX !== "visible" || st.overflowY !== "visible" || (st.clip && st.clip !== "auto") || (st.clipPath && st.clipPath !== "none")) && el !== document.documentElement && el !== document.body;
    const box = clips ? el.getBoundingClientRect() : null;
    clipBoxes.set(el, box);
    return box;
  };
  // Whether a text rect is seen: inside the window and inside every box an ancestor clips it to (a
  // "visually hidden" skip link of 1 x 1 px, a slide of a carousel outside its frame, are not).
  const seen = (r, el) => {
    let [l, t, rt, b] = [Math.max(0, r.left), Math.max(0, r.top), Math.min(W, r.right), Math.min(H, r.bottom)];
    for (let a = el; a && rt - l > 1 && b - t > 1; a = a.parentElement) {
      const box = clipBoxOf(a);
      if (box) [l, t, rt, b] = [Math.max(l, box.left), Math.max(t, box.top), Math.min(rt, box.right), Math.min(b, box.bottom)];
    }
    return rt - l > 1 && b - t > 1;
  };
  const words = [];
  let biggest = null;
  let biggestPx = 0;
  const blockOf = (el) => {
    let b = el;
    while (b && b.parentElement && b !== document.body) {
      const d = getComputedStyle(b).display;
      if (d !== "inline" && d !== "contents") break;
      b = b.parentElement;
    }
    return b;
  };
  const walker = document.body ? document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT) : null;
  let n = 0;
  while (walker && walker.nextNode() && n < 20000) {
    n++;
    const node = walker.currentNode;
    const t = clean(node.nodeValue);
    if (!t) continue;
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    if (!rects.some(onScreen)) continue;
    if (!drawn(el) || !rects.some((r) => seen(r, el))) continue;
    words.push(t);
    const px = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (px > biggestPx + 0.5) {
      biggestPx = px;
      const block = blockOf(el);
      biggest = clean(block?.innerText || t) || t;
    }
  }
  const text = clean(words.join(" ")).slice(0, 4000);
  const controls = [];
  for (const el of document.querySelectorAll("a[href], button, [role=button], [role=link]")) {
    if (controls.length >= 60) break;
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || !drawn(el) || !seen(r, el)) continue;
    const label = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || "");
    controls.push({ text: label.slice(0, 120), href: el.href ? String(el.href) : el.getAttribute?.("href") ?? "" });
  }
  return { words: text ? text.split(" ").length : 0, biggest, biggestPx, text, controls, url: location.href };
}

// ---------------------------------------------------------------- pure reading

const fold = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Name parts too common to say a name is shown ("de", "van", initials). */
const NAME_PARTICLES = new Set(["van", "von", "der", "den", "del", "della", "dos", "das", "bin", "binti", "the", "and", "mr", "mrs", "ms", "dr"]);

/** The parts of a listed name worth looking for: words of 3 letters or more, or any part written in a script without spaces. */
export function nameParts(name) {
  return [...new Set(fold(name).split(/[^\p{L}\p{N}]+/u))].filter((p) => p && !NAME_PARTICLES.has(p) && (p.length >= 3 || /[^\p{Script=Latin}\p{N}]/u.test(p)));
}

/** The part of `name` the screen's `text` shows (as a whole word for a Latin name), or null. */
export function nameOnScreen(name, text) {
  const t = fold(text);
  for (const p of nameParts(name)) {
    if (/^[\p{Script=Latin}\p{N}]+$/u.test(p)) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, "u").test(t)) return p;
    } else if (t.includes(p)) return p;
  }
  return null;
}

// A link or button that reaches the person, by its address or its words.
const CONTACT_HREF = /^(mailto:|tel:)|(^|[./])(linkedin\.com\/in\/|calendly\.com|cal\.com|wa\.me|t\.me)|\/(contact|contact-me|get-in-touch|hire(-me)?)(\/|$|[?#])|#(contact|get-?in-?touch)$/i;
const CONTACT_TEXT = /\b(contact|get in touch|let'?s talk|let’s talk|let'?s connect|let’s connect|hire me|work with me|email me|e-mail|email|say hi|say hello|reach out|book a call|schedule a call|linkedin)\b/i;
// A link or button that shows the work.
const WORK_HREF = /(^|[./])github\.com\/[^/?#]+|\/(projects?|work|portfolio|case-stud(y|ies))(\/|$|[?#])|#(projects?|work|portfolio)$/i;
const WORK_TEXT = /\b(projects?|my work|our work|work|portfolio|case stud(y|ies)|explore|see what i|github|demos?)\b/i;

/**
 * The first control on the screen that is a way to reach the person or see
 * their work, as { text, kind: "contact" | "work" }, or null. A link back to
 * the page itself (a logo to "/") is neither.
 * @param {{ text: string, href: string }[]} controls
 */
export function wayOnScreen(controls, pageUrl = "") {
  const here = String(pageUrl).replace(/#.*$/, "").replace(/\/$/, "");
  const kindOf = ({ text, href }) => {
    const h = String(href ?? "");
    const toSelf = h && !/#./.test(h) && h.replace(/#.*$/, "").replace(/\/$/, "") === here;
    if (CONTACT_HREF.test(h) || CONTACT_TEXT.test(text)) return "contact";
    if (toSelf) return null;
    if (WORK_HREF.test(h) || WORK_TEXT.test(text)) return "work";
    return null;
  };
  for (const c of Array.isArray(controls) ? controls : []) {
    const kind = kindOf(c);
    if (!kind) continue;
    const text = String(c.text ?? "").trim() || String(c.href ?? "").replace(/^mailto:/i, "").slice(0, 80);
    return { text: text.slice(0, BIGGEST_MAX), kind };
  }
  return null;
}

const quoteOf = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > BIGGEST_MAX ? `${t.slice(0, BIGGEST_MAX - 1).trimEnd()}…` : t;
};

/**
 * One reading from the page's first screen (readFirstScreen's answer) and the
 * listed name: { atMs, biggest, nameHit, way, wayKind, words }.
 */
export function screenReading(raw, { name = "", atMs = null } = {}) {
  const words = Number(raw?.words) || 0;
  const way = words || raw?.controls?.length ? wayOnScreen(raw?.controls ?? [], raw?.url ?? "") : null;
  return {
    ...(atMs == null ? {} : { atMs: Math.round(atMs) }),
    biggest: words ? quoteOf(raw?.biggest) : null,
    nameHit: nameOnScreen(name, raw?.text ?? ""),
    way: way?.text ?? null,
    wayKind: way?.kind ?? null,
    words,
  };
}

/**
 * Whether at five seconds the screen was still an intro or still loading:
 * nothing readable yet on a site that has words, or, when the settled page
 * fills its first screen (READY_WORDS or more), under READY_WORDS words and
 * under half of what it settles to. A sparse page that looks the same at five
 * seconds and later is not an intro. `siteWords`: how many words the site's
 * settled screen shows in any view, for a view with no settled reading.
 */
export function introAt5(at5, later, siteWords = 0) {
  if (!at5) return null;
  if (at5.words === 0) return Boolean((later?.words ?? siteWords) > 0);
  if (!later || later.words < READY_WORDS || !later.biggest) return false;
  return at5.words < READY_WORDS && at5.words < later.words / 2;
}

/** A view's measured reading: { state: "measured", at, applied, at5, later, intro }. */
export function measuredView({ at5, later = null, applied, at = new Date(), siteWords = 0 }) {
  return { state: "measured", at: at.toISOString(), applied, at5, later, intro: introAt5(at5, later, siteWords) };
}

/** A view that could not be read: { state: "not-measured", reason, at, applied }. */
export const notMeasured = (reason, { applied, at = new Date() } = {}) => ({ state: "not-measured", reason: String(reason ?? "unknown").slice(0, 160), at: at.toISOString(), applied });

/**
 * One capture's first_five from its raw readings (pure):
 *   desktopAt5    readAtFive's answer on the capture's visit, with the main
 *                 document's { status, cfMitigated } at that moment
 *   desktopLater  readNow's answer on the settled desktop page, or null
 *   phoneLater    readFirstScreen's answer on the settled phone view, or null
 *   mobile        readMobileFirstFive's answer, or { error } when it was not made
 * `name` is the listed name; `viewport` the desktop visit's size.
 */
export function firstFiveOf({ desktopAt5, desktopLater = null, phoneLater = null, mobile, name = "", viewport, at = new Date() }) {
  const dApplied = desktopApplied(viewport);
  const dLater = desktopLater?.raw ? screenReading(desktopLater.raw, { name }) : null;
  const mLater = phoneLater ? screenReading(phoneLater, { name }) : null;
  const siteWords = Math.max(dLater?.words ?? 0, mLater?.words ?? 0);
  let desktop;
  if (!desktopAt5 || desktopAt5.error) desktop = notMeasured(desktopAt5?.error ?? "not read", { applied: dApplied, at });
  else if (blockedAnswer(desktopAt5) || CHECK_TEXT.test(String(desktopAt5.raw?.text ?? "")))
    desktop = notMeasured(`a bot check or an error page (HTTP ${desktopAt5.status}) was showing at five seconds`, { applied: dApplied, at });
  else desktop = measuredView({ at5: screenReading(desktopAt5.raw, { name, atMs: desktopAt5.atMs }), later: dLater, applied: dApplied, at, siteWords });
  const m = !mobile || mobile.error ? notMeasured(mobile?.error ?? "not read", { applied: MOBILE_APPLIED, at }) : measuredView({ at5: mobile.at5, later: mLater, applied: MOBILE_APPLIED, at, siteWords });
  return { v: FIRST_FIVE_VERSION, mobile: m, desktop };
}

/**
 * The stored facts' first_five with a new capture's readings: a view the new
 * capture measured replaces the stored one; a view it could not measure keeps
 * a stored measured reading (with its own date), else stores why it could not.
 */
export function withFirstFive(stored, next) {
  const prev = stored && typeof stored === "object" && Number(stored.v) === FIRST_FIVE_VERSION ? stored : null;
  const pick = (k) => (next?.[k]?.state === "measured" || prev?.[k]?.state !== "measured" ? next?.[k] ?? prev?.[k] ?? null : prev[k]);
  return { v: FIRST_FIVE_VERSION, mobile: pick("mobile"), desktop: pick("desktop") };
}

// ---------------------------------------------------------------- in the browser

/** The screen before any document arrived. */
const BLANK = Object.freeze({ words: 0, biggest: null, biggestPx: 0, text: "", controls: [], url: "about:blank" });
/** How long the mobile visit waits past five seconds for its first answer, to tell a slow site from a bot check. */
export const ANSWER_WAIT_MS = 4000;
/** A screen that is a bot or security check, not the site (Cloudflare's and the common ones' own words). */
export const CHECK_TEXT = /verifying you are human|checking (?:your|if the site connection is) (?:browser|secure)|just a moment\.\.\.|needs to review the security of your connection|attention required/i;
/** Whether the main document's answer is a bot check or an error: the reading is then about this visit, not the site. */
export const blockedAnswer = ({ status = 0, cfMitigated = "" } = {}) => status >= 400 || /challenge/i.test(String(cfMitigated));

/** `promise`, or a rejection once `ms` have passed. */
const within = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
};

/**
 * Reads the screen of `page` at `startedAt + AT_MS`. Never throws: returns
 * { raw, atMs } or { error }. A reading made while a new document replaced the
 * old one is tried once more at once.
 * @param {import("playwright").Page} page
 */
export async function readAtFive(page, startedAt, { atMs = AT_MS, lateMs = LATE_MS } = {}) {
  const wait = startedAt + atMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  // No document yet at five seconds (the site has not answered, or its page has not begun to arrive):
  // the visitor sees a blank screen. Asked now, since a reading asked for would wait for the document.
  if (!page.isClosed() && /^about:blank$/.test(page.url())) return { raw: BLANK, atMs: Date.now() - startedAt };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (page.isClosed()) return { error: "the page closed before five seconds" };
      const raw = await within(page.evaluate(readFirstScreen), READ_LIMIT_MS, "reading the screen");
      const at = Date.now() - startedAt;
      if (at > lateMs) return { error: `the page was too busy to read until ${(at / 1000).toFixed(1)} s` };
      return { raw, atMs: at };
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (attempt === 0 && /context was destroyed|navigat/i.test(msg)) continue;
      if (/took over/.test(msg)) return { error: "the page did not answer at five seconds" };
      return { error: `the screen could not be read (${msg.slice(0, 80)})` };
    }
  }
  return { error: "the page kept loading a new document at five seconds" };
}

/** Reads the settled screen of `page` now: { raw, atMs } or { error }. Never throws. */
export async function readNow(page, startedAt) {
  try {
    const raw = await within(page.evaluate(readFirstScreen), READ_LIMIT_MS, "reading the screen");
    return { raw, atMs: Date.now() - startedAt };
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 80) };
  }
}

/**
 * The phone's first five seconds: a separate visit to `url` in a fresh
 * context of `browser`, throttled as MOBILE, read at AT_MS and closed.
 * Returns { at5 } or { error }; never throws, and takes at most `limitMs`
 * (the closing of the context included, bounded too).
 * `isBlocked({ status, cfMitigated })`: whether the visit's main document
 * answered with a bot check or an error (the capture's own rule), which makes
 * the reading not measured.
 * @param {import("playwright").Browser} browser
 */
export async function readMobileFirstFive(browser, url, { name = "", userAgent, limitMs = MOBILE_LIMIT_MS, isBlocked = blockedAnswer } = {}) {
  let ctx = null;
  const run = async () => {
    ctx = await browser.newContext({
      viewport: { width: MOBILE.width, height: MOBILE.height },
      deviceScaleFactor: MOBILE.scale,
      isMobile: true,
      hasTouch: true,
      userAgent: mobileUA(userAgent),
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: MOBILE.latencyMs,
      downloadThroughput: (MOBILE.downKbps * 1024) / 8,
      uploadThroughput: (MOBILE.upKbps * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: MOBILE.cpuSlowdown });
    const doc = { status: 0, cfMitigated: "" };
    page.on("response", (res) => {
      try {
        if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) {
          doc.status = res.status();
          doc.cfMitigated = res.headers()["cf-mitigated"] ?? "";
        }
      } catch {
        /* a response without a frame: not the document */
      }
    });
    const startedAt = Date.now();
    page.goto(url, { waitUntil: "commit", timeout: limitMs }).catch(() => {});
    const r = await readAtFive(page, startedAt);
    // Nothing had answered by five seconds: a blank screen is what a visitor sees, unless the answer
    // that comes is a bot check or an error, which is about this visit, not the site. A few seconds tell.
    const until = Date.now() + ANSWER_WAIT_MS;
    while (doc.status === 0 && Date.now() < until && !page.isClosed()) await new Promise((res) => setTimeout(res, 200));
    if (isBlocked(doc) || CHECK_TEXT.test(String(r.raw?.text ?? "")))
      return { error: doc.status >= 400 ? `the second visit was answered with HTTP ${doc.status}${doc.cfMitigated ? ` (${doc.cfMitigated})` : ""}` : "the second visit was answered with a bot check" };
    if (r.error) return { error: r.error };
    return { at5: screenReading(r.raw, { name, atMs: r.atMs }) };
  };
  try {
    return await within(run(), limitMs, "the mobile visit");
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 120) };
  } finally {
    if (ctx) await within(ctx.close(), 10000, "closing the mobile visit").catch(() => {});
  }
}
