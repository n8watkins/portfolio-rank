// "Add your portfolio" adds a site only once it is really there (owner,
// 2026-11-13): one GET with a time limit, which must answer 200 with HTML
// that isn't a parked or for-sale page. Only then does it run the checks and
// queue the grade. Plain functions, so the tests need no network.

import { fetchSameSite } from "../ownership/verify.mjs";

export const EXISTS_TIMEOUT_MS = 8000;
export const EXISTS_MAX_BYTES = 256 * 1024;

// Phrases parked, for-sale and placeholder pages carry, from the registrars
// and parking services that serve most of them. Lower case; matched in the
// page's visible text and title.
const PARKED = [
  /\bthis domain (?:name )?(?:is|may be) for sale\b/,
  /\bdomain (?:is )?for sale\b/,
  /\bbuy this domain\b/,
  /\bmake an offer on this domain\b/,
  /\bthis domain (?:name )?has expired\b/,
  /\bthis domain is parked\b/,
  /\bparked (?:free|domain)\b/,
  /\bdomain parking\b/,
  /\b(?:hugedomains|sedoparking|sedo\.com|dan\.com|afternic|bodis|parkingcrew|above\.com)\b/,
];
// Placeholders a real page could mention in passing, so they count only on
// a short page (a server's default page, a holding page).
const PLACEHOLDER = [/\bwebsite is (?:coming soon|under construction)\b/, /\bcoming soon\b/, /\bdefault web site page\b/, /\bwelcome to nginx\b/, /\bit works!/];
const SHORT_PAGE = 400;

/** The page's title and visible text, lower case, scripts and styles left out. */
export function visibleText(html) {
  return String(html ?? "")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True for a parked, for-sale, expired or default server page. */
export function looksParked(html) {
  const text = visibleText(html);
  return PARKED.some((re) => re.test(text)) || (text.length < SHORT_PAGE && PLACEHOLDER.some((re) => re.test(text)));
}

/**
 * The existence check. `hop(url)` makes one request without following
 * redirects (lib/ownership/hop.ts siteHop); at most 3 redirects, on the same
 * site. Returns { ok: true, finalUrl } or { ok: false, reason, message }.
 * @param {{ url: string, hop: (url: string) => Promise<Response> }} args
 */
export async function siteExists({ url, hop }) {
  const got = await fetchSameSite(url, { hop, maxBytes: EXISTS_MAX_BYTES });
  if (!got.ok) {
    if (got.error === "off_site") return { ok: false, reason: "redirects_away", message: "That address sends visitors to another site. Add the portfolio's own address." };
    if (got.error === "too_many_redirects") return { ok: false, reason: "redirect_loop", message: "That address redirects too many times." };
    return { ok: false, reason: "unreachable", message: "We couldn't load that page. Check the address and that the site is up." };
  }
  if (got.status !== 200) return { ok: false, reason: "not_ok", message: `That page answered ${got.status}, not a working page.` };
  if (!/text\/html|application\/xhtml/i.test(got.type)) return { ok: false, reason: "not_html", message: "That address isn't a web page." };
  if (visibleText(got.text).length === 0 && !/<(?:div|main|body)\b/i.test(got.text)) return { ok: false, reason: "empty", message: "That page is empty." };
  if (looksParked(got.text)) return { ok: false, reason: "parked", message: "That looks like a parked or for-sale page, not a portfolio." };
  return { ok: true, finalUrl: got.finalUrl };
}
