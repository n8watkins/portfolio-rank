// The sitemap index and its parts (docs/BOTS-AND-SEO.md F5): /sitemap.xml
// lists /sitemap/pages.xml (the site's own pages), /sitemap/blog.xml (the
// blog) and /sitemap/profiles-<n>.xml (portfolio profiles, PROFILES_PER_FILE
// each, well under the 50,000 URLs a file may hold), each with the newest
// lastmod among its URLs. A URL has a lastmod only when real data says when
// it changed; changefreq and priority are left out (Google ignores them).
// Plain JavaScript: the routes (app/sitemap.xml, app/sitemap/[part]) and the
// tests import it.

export const PROFILES_PER_FILE = 10_000;

/** The parts' names, as /sitemap/<name>.xml. */
export const PAGES_PART = "pages";
export const BLOG_PART = "blog";
export const profilesPart = (n) => `profiles-${n}`;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * A time as W3C datetime, or null: ISO strings as they are, SQLite's
 * "YYYY-MM-DD HH:MM:SS" (UTC, from datetime('now')) read as UTC, epoch ms.
 * @param {unknown} t
 */
export function isoTime(t) {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? t : Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(t)) ? `${String(t).replace(" ", "T")}Z` : String(t));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** The latest of several times, or null when none is known. */
export function latest(...times) {
  const ms = times.map(isoTime).filter(Boolean).map((t) => Date.parse(t));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
}

/**
 * @typedef {{ url: string, lastmod?: string | null }} Entry
 */

/** @param {Entry[]} entries */
export function urlsetXml(entries) {
  const body = entries.map((e) => `<url><loc>${esc(e.url)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** @param {Entry[]} parts the parts' absolute URLs */
export function sitemapIndexXml(parts) {
  const body = parts.map((e) => `<sitemap><loc>${esc(e.url)}</loc>${e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : ""}</sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/**
 * Profiles cut into files of `size`, in the given order (the list's, so a
 * site stays in the same file from day to day). Always at least one file,
 * so the index never points at a missing part.
 * @template T
 * @param {T[]} profiles
 */
export function chunk(profiles, size = PROFILES_PER_FILE) {
  const out = [];
  for (let i = 0; i < profiles.length; i += size) out.push(profiles.slice(i, i + size));
  return out.length ? out : [[]];
}

/** The newest lastmod among entries, for the index. */
export const newest = (entries) => latest(...entries.map((e) => e.lastmod));

/** A part name from the route ("profiles-2.xml"), or null for anything else. */
export function parsePart(raw) {
  const m = String(raw).match(/^(pages|blog|profiles-([1-9]\d{0,3}))\.xml$/);
  if (!m) return null;
  return m[2] ? { kind: "profiles", n: Number(m[2]) } : { kind: m[1] };
}

export const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" };
