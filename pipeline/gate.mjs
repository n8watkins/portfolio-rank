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
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

/**
 * HTTP-level gate. Returns { status: 'live'|'dead'|'parked'|'error', reason,
 * finalUrl?, httpStatus?, html? }. 'dead' is definitive (DNS failure, 404, 410);
 * 'error' is anything that may be transient (timeout, TLS, 5xx, 403 from a bot
 * wall) and must be retried, never treated as final.
 */
export async function httpGate(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = String(e?.cause?.code ?? e?.cause ?? e);
    if (/ENOTFOUND|EAI_AGAIN/.test(msg))
      return { status: "dead", reason: "DNS resolution failed" };
    if (/CERT|certificate/i.test(msg))
      return { status: "error", reason: "TLS error" };
    if (e?.name === "TimeoutError")
      return { status: "error", reason: "timeout" };
    return { status: "error", reason: msg.slice(0, 120) };
  }
  const finalUrl = res.url || url;
  if (res.status === 404 || res.status === 410)
    return { status: "dead", reason: `HTTP ${res.status}`, finalUrl, httpStatus: res.status };
  if (!res.ok)
    return { status: "error", reason: `HTTP ${res.status}`, finalUrl, httpStatus: res.status };
  if (isParkingDomain(finalUrl))
    return { status: "parked", reason: `redirects to ${netloc(finalUrl)}`, finalUrl, httpStatus: res.status };
  const html = (await res.text()).slice(0, 262144);
  const phrase = parkingPhrase({ html });
  if (phrase)
    return { status: "parked", reason: `parking phrase: "${phrase}"`, finalUrl, httpStatus: res.status };
  return { status: "live", reason: "", finalUrl, httpStatus: res.status, html };
}
