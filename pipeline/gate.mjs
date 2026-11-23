// The HTTP gate shared by pipeline/capture.mjs (before screenshots) and
// pipeline/health.mjs (the weekly health check): is a site up, parked or for
// sale? Tables ported from pipeline/check_parking_redirects.py.
import { firstTitle, removeElements, stripTags } from "./page-controls.mjs";

export const PARKING_DOMAINS = new Set([
  "sedoparking.com", "sedo.com", "bodis.com", "parkingcrew.net",
  "sav.com", "dan.com", "afternic.com", "hugedomains.com",
  "undeveloped.com", "buydomains.com", "brandbucket.com", "efty.com",
  "domainmarket.com", "above.com", "parklogic.com", "uniregistry.com",
  "domainnameshop.com", "registrar-servers.com", "topdns.com",
  "godaddysites.com", "secureserver.net", "domaincontrol.com",
  "domainnamesales.com", "domainagents.com", "squadhelp.com",
  "flippa.com", "epik.com",
]);
export const PARKING_PHRASES = [
  "domain for sale", "buy this domain", "this domain is for sale",
  "make an offer", "parked domain", "this domain is parked",
  "domain parking", "purchase this domain", "inquire about this domain",
  "this web page is parked", "the domain has expired", "domain has expired",
  "this domain expired", "renew this domain", "domain registration expired",
  // GoDaddy's parking lander (nic-nguyen.com, 2026-11-23): "<domain> has
  // expired and is parked free, courtesy of GoDaddy.com."
  "has expired and is parked", "parked free, courtesy of",
];

// What a parking service's own lander carries in its HTML, whatever its text:
// the script that draws GoDaddy's lander (img1.wsimg.com/parking-lander,
// window.LANDER_SYSTEM, its traffic tag "ap: parking"; nic-nguyen.com/lander,
// 2026-11-23) and scripts loaded (a `src`, never a `data-src`) from the
// parking hosts themselves. Like the phrases, a marker counts only on a page
// with little visible text.
const PARKING_MARKERS = [
  [/\bwindow\.LANDER_SYSTEM\s*=/, "GoDaddy parking lander"],
  [/\/\/img\d*\.wsimg\.com\/parking-lander\//i, "GoDaddy parking lander"],
  [/_trfd\.push\([^)]*?["']?\bap["']?\s*:\s*["']parking["']/, "GoDaddy parking lander"],
  [/<script\b[^>]*?\ssrc\s*=\s*["']?(?:https?:)?\/\/(?:[\w-]+\.)*(sedoparking\.com|parkingcrew\.net|bodis\.com|parklogic\.com|above\.com|dan\.com|afternic\.com|hugedomains\.com)\//i, "a script from a parking service"],
];
// The User-Agent of the plain requests (and of the capture's browser, which
// imports UA). It names a current Chrome, worked out from the date, so it
// never goes stale: a pinned "Chrome/124" was 2.5 years old by 2026-11, and
// sites behind bot rules dropped the connection for it while answering 200
// to curl and to Chrome 125+ (the 2026-11-16 health run). Chrome ships a
// major version about every four weeks, with a longer gap over the winter
// holidays; CHROME_RATE_DAYS averages both, and the estimate stays a version
// behind stable, which is what most real visitors run. No Node APIs: the
// Worker bundles this file (lib/grader/quick.ts).
const CHROME_ANCHOR = { major: 141, at: Date.UTC(2025, 8, 30) }; // Chrome 141 stable, 2025-09-30
const CHROME_RATE_DAYS = 30;

/** The Chrome major version a current desktop visitor runs at `now` (never below the anchor's). */
export function chromeMajor(now = Date.now()) {
  const days = (Number(now) - CHROME_ANCHOR.at) / 86400000;
  return CHROME_ANCHOR.major + Math.max(0, Math.floor(days / CHROME_RATE_DAYS) - 1);
}

/** A desktop Chrome User-Agent for a major version (Chrome itself reports only the major). */
export const chromeUA = (major = chromeMajor()) =>
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

export const UA = chromeUA();

export const netloc = (url) => {
  try {
    const n = new URL(url).hostname.toLowerCase();
    return n.startsWith("www.") ? n.slice(4) : n;
  } catch {
    return "";
  }
};

export const isParkingDomain = (url) => {
  const d = netloc(url);
  return [...PARKING_DOMAINS].some((p) => d === p || d.endsWith("." + p));
};

// A real portfolio can mention "make an offer" or "domain parking" in its
// content, so a phrase only counts on a page that is mostly that message:
// in the <title>, or on a page with little visible text. A check of all 2,103
// roster sites (2026-11-10) found 10 keyword hits, all on real portfolios
// with 1,349 to 86,484 characters of text.
export const PARKED_MAX_TEXT = 1200;

/** The first parking phrase found in a string, or undefined. */
const findPhrase = (s) => {
  // Rendered text breaks lines between elements ("nic-nguyen.com\nhas expired and is parked").
  const body = String(s ?? "").toLowerCase().replace(/\s+/g, " ");
  return PARKING_PHRASES.find((p) => body.includes(p));
};

/** The page's <title>, if any. */
export const titleOf = (html) => firstTitle(html).trim();

/**
 * The parking phrase that marks this page as parked, or undefined. Pass the
 * raw HTML (for the title) and/or the visible text.
 */
export function parkingPhrase({ html = "", text, title } = {}) {
  const t = title ?? titleOf(html);
  const fromTitle = findPhrase(t);
  if (fromTitle) return fromTitle;
  const visible = text ?? visibleText(html);
  if (visible.length > PARKED_MAX_TEXT) return undefined;
  return findPhrase(visible);
}

/**
 * The parking service whose lander this HTML is (PARKING_MARKERS), or
 * undefined. Only on a page with little visible text (PARKED_MAX_TEXT), as
 * for the phrases. `text`: the visible text when the caller has it.
 */
export function parkingMarker(html, text) {
  const visible = text ?? visibleText(html);
  if (visible.length > PARKED_MAX_TEXT) return undefined;
  const h = String(html ?? "");
  return PARKING_MARKERS.find(([re]) => re.test(h))?.[1];
}

/**
 * Whether the page where a visit ended (a plain request's answer, or the
 * browser's rendered page) is a parking page, and why: the failure reason,
 * or null. The one judgement of the health check (pipeline/health.mjs
 * checkSite, on the browser's page) and the capture (pipeline/capture.mjs
 * judgeDesktop), as httpGate makes it on the served page. Only positive
 * evidence counts, in order:
 *   - it ended on a parking host (isParkingDomain): "redirects to <host>";
 *   - a parking phrase in the title, or on a short page: "parking phrase: ...";
 *   - a parking service's lander (parkingMarker): "parking page: <service>".
 * A path, a short or empty page, or a page that could not be read is never
 * evidence: a single-page app's first HTML is nearly empty too.
 */
export function parkedPage({ finalUrl = "", html = "", text, title } = {}) {
  if (isParkingDomain(finalUrl)) return `redirects to ${netloc(finalUrl)}`;
  const visible = String(text ?? visibleText(html)).trim();
  const phrase = parkingPhrase({ html, text: visible, title });
  if (phrase) return `parking phrase: "${phrase}"`;
  const marker = parkingMarker(html, visible);
  if (marker) return `parking page: ${marker}`;
  return null;
}

// A home page that is nothing but a redirect made on load (a script setting
// location, or a meta refresh of a few seconds), as parking services serve
// one (nic-nguyen.com, 2026-11-23: 114 bytes,
// `window.onload=function(){window.location.href="/lander"}`). Only small
// pages with no text of their own (<noscript> text counts as text) are read
// for one, and only a redirect that always runs on load: a script whose whole
// body is the assignment, or a window.onload / load / DOMContentLoaded handler
// whose whole body is. Never one inside a click handler or a condition, a
// variable or property that happens to be named location, or a long meta
// refresh (a session timeout). The redirect is followed and judged
// (parkedAfterClientRedirect), never called parked for being small.
export const CLIENT_REDIRECT_MAX_HTML = 8192;
/** A meta refresh waiting longer than this many seconds is not a redirect of the home page. */
export const META_REFRESH_MAX_S = 5;
/** Fewer characters of its own than this, and a page is only a redirect. */
const SHELL_TEXT = 30;
const ASSIGN = /^(?:(?:window|document|self|top)\.)?location(?:\.href)?\s*=\s*(["'`])([^"'`\s]+)\1$/;
const CALL = /^(?:(?:window|document|self|top)\.)?location\.(?:replace|assign)\(\s*(["'`])([^"'`\s]+)\1\s*\)$/;
const FN = String.raw`(?:function\s*\w*\s*\(\s*\)|\(\s*\)\s*=>)\s*\{([\s\S]*)\}`;
const ON_LOAD = [
  new RegExp(String.raw`^(?:window\.)?onload\s*=\s*${FN}$`),
  new RegExp(String.raw`^(?:window|document)\.addEventListener\(\s*["'](?:load|DOMContentLoaded)["']\s*,\s*${FN}\s*(?:,\s*\w+\s*)?\)$`),
];

/** A statement's text without the semicolons and space around it. */
const statement = (s) => String(s).trim().replace(/;+\s*$/, "").trim();

/** The fixed address a script whose whole body is a redirect on load sends the browser to, or null. */
function scriptTarget(body) {
  let s = statement(body);
  const wrapped = ON_LOAD.map((re) => s.match(re)).find(Boolean);
  if (wrapped) s = statement(wrapped[1]);
  const m = s.match(ASSIGN) ?? s.match(CALL);
  return m ? m[2] : null;
}

/**
 * Where a page that is only a client-side redirect on load sends the browser,
 * as an absolute http(s) URL, or null: a meta refresh with a URL after at most
 * META_REFRESH_MAX_S seconds, or an inline script that only sets the location
 * to a fixed address (scriptTarget). Only for a page of at most
 * CLIENT_REDIRECT_MAX_HTML characters with no text of its own.
 */
export function clientRedirect(html, baseUrl) {
  const h = String(html ?? "");
  if (!h || h.length > CLIENT_REDIRECT_MAX_HTML) return null;
  // Its own text, <noscript> included (a single-page app's "You need to enable JavaScript").
  const own = stripTags(removeElements(removeElements(h, "script"), "style")).replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  if (own.length >= SHELL_TEXT) return null;
  let target = null;
  for (const tag of h.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?refresh\b/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? tag.match(/\bcontent\s*=\s*([^\s>]+)/i)?.[1] ?? "";
    const m = content.match(/^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*url\s*=\s*['"]?([^'"\s]+)/i);
    if (m && Number(m[1] ?? 0) <= META_REFRESH_MAX_S) {
      target = m[2];
      break;
    }
  }
  if (!target) {
    for (const [, body] of h.matchAll(/<script\b(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      target = scriptTarget(body);
      if (target) break;
    }
  }
  if (!target) return null;
  try {
    const u = new URL(target, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const withoutHash = (url) => String(url).replace(/#.*$/, "");

/**
 * Follows one client-side redirect (clientRedirect) from the page at `from`
 * to `to`, and returns { reason, finalUrl } when it lands on a parking page,
 * else null. A parking host is decided by its name, without a request. Any
 * other host is not followed (a person's domain sending visitors to their
 * other site is a move, judged by the health check's redirectVerdict on the
 * browser's page). On the same host: one plain GET with the gate's headers,
 * fetch and timeout (HTTP redirects followed as in httpGate, no further
 * client redirect), then parkedPage on what it answered. A page there that
 * could not be read (a dropped connection, a timeout, an error status) or that
 * shows no positive evidence is no verdict: null, and the browser decides, as
 * for timeouts and bot walls everywhere else.
 */
async function parkedAfterClientRedirect(from, to, { fetchImpl, timeoutMs, userAgent }) {
  if (isParkingDomain(to)) return { reason: `redirects to ${netloc(to)}`, finalUrl: to };
  if (netloc(to) !== netloc(from) || withoutHash(to) === withoutHash(from)) return null;
  try {
    const res = await fetchImpl(to, { redirect: "follow", headers: navigationHeaders(userAgent), signal: AbortSignal.timeout(timeoutMs) });
    const landed = res.url || to;
    if (isParkingDomain(landed)) return { reason: `redirects to ${netloc(landed)}`, finalUrl: landed };
    if (!res.ok) return null;
    const reason = parkedPage({ finalUrl: landed, html: await readBody(res, 262144) });
    return reason ? { reason, finalUrl: landed } : null;
  } catch {
    return null;
  }
}

/**
 * Runs in the page (page.evaluate): the rendered text, and whether the page
 * shows visual content without text. Canvas apps (Flutter web draws the whole
 * site on a canvas) and image-only pages have no innerText but are not blank.
 */
export function readRenderedPage() {
  const text = document.body?.innerText ?? "";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 100;
  };
  const media = [...document.querySelectorAll("canvas, img, svg, video, flt-glass-pane, flutter-view")].some(visible);
  // The rendered DOM, for the portfolio-likeness signals and facts of
  // single-page apps, at most 400,000 characters. A page longer than that
  // loses what no fact reads first (inline script and style bodies, image
  // srcsets, style attributes, inline data: images, SVG path data), so the
  // cut no longer takes its footer's GitHub and email links (facts audit,
  // 2026-11-21: two of 70 listed sites lost them to inline images and
  // srcsets).
  let html = document.documentElement.outerHTML;
  if (html.length > 400000) {
    html = html
      .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, "$1$3")
      .replace(/\s(?:srcset|sizes|style|d|points)="[^"]*"/g, "")
      .replace(/data:[\w.+-]+\/[\w.+-]+[^"')\s]{64,}/g, "data:");
  }
  html = html.slice(0, 400000);
  return { text, media, html };
}

/** Visible text of an HTML document, roughly: tags, scripts and styles removed. */
export function visibleText(html) {
  // Linear passes (./page-controls.mjs): the quick grade reads up to 1.5 MB
  // from any address, and /<[^>]+>/g took 13 s on 500 KB of "a <b && c".
  return stripTags(removeElements(removeElements(removeElements(html, "script"), "style"), "noscript"))
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Failures of the request itself that say nothing about the site: the
// connection was dropped or reset mid-way (a bot filter often does this to an
// automated client: UND_ERR_SOCKET "other side closed", ECONNRESET, an HTTP/2
// protocol error), the answer was too slow (a timeout while waiting for the
// headers or the body), or the runner's own DNS resolver failed for a moment
// (EAI_AGAIN). They are retried and asked of the browser like any error, and
// the health check never counts them as a failed check (pipeline/health.mjs).
// Connection refused, a connect timeout (undici's UND_ERR_CONNECT_TIMEOUT,
// ETIMEDOUT: nothing answers at the address) and a TLS failure are not on the
// list: those are what a site that is really down looks like.
const TRANSIENT_CODE = /^(UND_ERR_SOCKET|ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_ABORTED|EAI_AGAIN|ERR_HTTP2_\w+)$/;
const CONNECT_TIMEOUT_CODE = /^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT)$/;

const errorCode = (e) => String(e?.cause?.code ?? e?.code ?? "");
/** The request's own deadline ran out (AbortSignal.timeout): the answer, or its body, was too slow. */
const isDeadline = (e) => e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";

/** The gate's answer for a request (or a body read) that threw. */
function requestFailed(e) {
  const code = errorCode(e);
  const msg = String(e?.cause?.code ?? e?.cause?.message ?? e?.cause ?? e?.message ?? e);
  if (code === "ENOTFOUND" || (!code && /ENOTFOUND/.test(msg))) return { status: "dead", reason: "DNS resolution failed" };
  if (code === "EAI_AGAIN" || /EAI_AGAIN/.test(msg)) return { status: "error", reason: "DNS lookup failed for a moment (EAI_AGAIN)", transient: true };
  if (CONNECT_TIMEOUT_CODE.test(code) || e?.cause?.name === "ConnectTimeoutError") return { status: "error", reason: "connect timeout (nothing answers at the address)" };
  if (/CERT|certificate|SSL/i.test(msg)) return { status: "error", reason: "TLS error" };
  if (isDeadline(e)) return { status: "error", reason: "timeout", transient: true };
  if (TRANSIENT_CODE.test(code)) return { status: "error", reason: `connection dropped (${code})`, transient: true };
  return { status: "error", reason: msg.slice(0, 120) };
}

/** The body of an answer, read under the same deadline as the request; throws like the request does. */
const readBody = async (res, limit) => String(await res.text()).slice(0, limit);

/**
 * The page-request headers of a desktop Chrome that Node's fetch carries as
 * given: the User-Agent, Accept and Accept-Language. Some hosts answer a
 * request with only a User-Agent with an error (juanbenito.vercel.app: HTTP
 * 500 "Internal Server Error", 21 bytes) and the page to these (HTTP 200,
 * 107 KB; 2026-11-17, confirmed with Accept and Accept-Language alone).
 * No Sec-Fetch-* or Upgrade-Insecure-Requests: Node's fetch (undici) rewrites
 * sec-fetch-mode to "cors", and "cors" beside sec-fetch-dest "document" is a
 * pair no browser sends.
 */
export const navigationHeaders = (userAgent = chromeUA()) => ({
  "User-Agent": userAgent,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
});

/**
 * The reason for an error answer: "HTTP <status>", with what the host says
 * when it names a cause that may pass by itself (a Vercel project paused
 * until its free allowance resets, a deployment that no longer exists while
 * the person still owns the address), so those can be told apart later.
 */
export function httpReason(status, page = "") {
  const p = String(page ?? "");
  if (/deployment is temporarily paused|DEPLOYMENT_PAUSED/i.test(p)) return `HTTP ${status}: deployment paused`;
  if (status === 402) return "HTTP 402: payment required (hosting paused)";
  if (/DEPLOYMENT_NOT_FOUND/.test(p)) return `HTTP ${status}: deployment not found`;
  return `HTTP ${status}`;
}

/**
 * HTTP-level gate. Returns { status: 'live'|'dead'|'parked'|'error', reason,
 * finalUrl?, httpStatus?, html?, transient? }. 'dead' is definitive (the name
 * does not exist, 404, 410); 'error' is anything that may be transient
 * (timeout, TLS, 5xx, 403 from a bot wall) and must be retried, never treated
 * as final. `transient` marks an error that says nothing about the site
 * (TRANSIENT_CODE, a timeout). An error answer (4xx, 5xx) carries the start
 * of its page in `html`, so a bot wall can be told from a broken site.
 * `userAgent` defaults to UA, worked out for the current date.
 */
export async function httpGate(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, userAgent = chromeUA() } = {}) {
  // One deadline covers the request and the body: a slow body is a timeout, not a crash.
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", headers: navigationHeaders(userAgent), signal });
  } catch (e) {
    return requestFailed(e);
  }
  const finalUrl = res.url || url;
  if (!res.ok) {
    const page = await readBody(res, 65536).catch(() => "");
    const reason = httpReason(res.status, page);
    if (res.status === 404 || res.status === 410) return { status: "dead", reason, finalUrl, httpStatus: res.status };
    return { status: "error", reason, finalUrl, httpStatus: res.status, html: page };
  }
  if (isParkingDomain(finalUrl))
    return { status: "parked", reason: `redirects to ${netloc(finalUrl)}`, finalUrl, httpStatus: res.status };
  let html;
  try {
    html = await readBody(res, 262144);
  } catch (e) {
    return { ...requestFailed(e), finalUrl, httpStatus: res.status };
  }
  const parked = parkedPage({ finalUrl, html });
  if (parked) return { status: "parked", reason: parked, finalUrl, httpStatus: res.status };
  // A home page that is only a redirect made in the page: where it sends the browser decides (one hop).
  const to = clientRedirect(html, finalUrl);
  const landed = to ? await parkedAfterClientRedirect(finalUrl, to, { fetchImpl, timeoutMs, userAgent }) : null;
  if (landed) return { status: "parked", reason: landed.reason, finalUrl: landed.finalUrl, httpStatus: res.status };
  return { status: "live", reason: "", finalUrl, httpStatus: res.status, html };
}
