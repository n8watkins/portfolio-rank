// A portfolio profile's address on PortfolioRank (docs/BOTS-AND-SEO.md F1).
//
// Readable: /p/<host><path>, with the scheme, "www.", the query, the fragment
// and a trailing slash dropped and the host in lower case:
//   https://www.JaneDoe.dev/        -> /p/janedoe.dev
//   https://jane.github.io/Portfolio -> /p/jane.github.io/Portfolio
// The path keeps its case (it reads as the person wrote it) but is matched
// without it, through the site key (lib/grader/url.mjs siteKeyOf), so one
// site has one profile whatever the case or scheme it was typed with.
//
// The old address was the whole URL percent-encoded in one segment
// (/p/https%3A%2F%2Fjanedoe.dev). A client that decodes it asks for
// /p/https://janedoe.dev, which Next.js turns into /p/https:/janedoe.dev;
// all three forms are permanent redirects to the readable one
// (worker/profile-redirect.ts, and app/p/[...slug] where the Worker isn't in
// front). Plain JavaScript: the pages, the Worker, the grade report's HTML
// and the tests import it.
import { siteKeyOf } from "./grader/url.mjs";

/**
 * The readable part of a profile's address: host and path, as above. Throws
 * on an address that isn't a URL.
 * @param {string} url
 */
export function profileSlug(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return `${host}${u.pathname.replace(/\/+$/, "")}`;
}

/** A portfolio's profile page: /p/<slug>. Falls back to the old encoded form for an address that isn't a URL. */
export function profilePath(url) {
  try {
    return `/p/${profileSlug(url)}`;
  } catch {
    return `/p/${encodeURIComponent(url)}`;
  }
}

/** Its share image (a catch-all route can't have opengraph-image under it). */
export const profileImagePath = (url) => profilePath(url).replace(/^\/p\//, "/og/p/");

/**
 * The slug a request asked for, from the route's segments (still
 * percent-encoded, as Next.js hands them over) or the path after /p/:
 * each segment decoded, joined with "/". Null when one doesn't decode.
 * @param {string[] | string} segments
 */
export function requestedSlug(segments) {
  const parts = typeof segments === "string" ? segments.split("/") : segments;
  try {
    return parts.map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
}

/**
 * The address an old-style profile path stands for, or null when it isn't
 * one: the decoded slug starts with a scheme, followed by one slash (what
 * Next.js leaves of a decoded "//") or two.
 * @param {string | null} slug requestedSlug()
 */
export function legacyAddress(slug) {
  const m = slug?.match(/^(https?):\/{1,2}(.+)$/i);
  if (!m) return null;
  try {
    return new URL(`${m[1].toLowerCase()}://${m[2]}`).href;
  } catch {
    return null;
  }
}

/**
 * The site key a readable slug looks a profile up by (its scheme doesn't
 * matter). Null for one that isn't a host and path.
 * @param {string | null} slug requestedSlug()
 */
export function slugKey(slug) {
  if (!slug || /^[a-z][a-z0-9+.-]*:/i.test(slug)) return null;
  try {
    return siteKeyOf(`https://${slug}`);
  } catch {
    return null;
  }
}
