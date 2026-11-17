// The HTTP gate shared by pipeline/capture.mjs (before screenshots) and
// pipeline/health.mjs (the weekly health check): is a site up, parked or for
// sale? Tables ported from pipeline/check_parking_redirects.py.

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
  const body = String(s ?? "").toLowerCase();
  return PARKING_PHRASES.find((p) => body.includes(p));
};

/** The page's <title>, if any. */
export const titleOf = (html) =>
  (String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();

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
  // The rendered DOM, for the portfolio-likeness signals of single-page apps.
  const html = document.documentElement.outerHTML.slice(0, 400000);
  return { text, media, html };
}

/** Visible text of an HTML document, roughly: tags, scripts and styles removed. */
export function visibleText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
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
  const phrase = parkingPhrase({ html });
  if (phrase)
    return { status: "parked", reason: `parking phrase: "${phrase}"`, finalUrl, httpStatus: res.status };
  return { status: "live", reason: "", finalUrl, httpStatus: res.status, html };
}
