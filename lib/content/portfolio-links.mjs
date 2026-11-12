// Links to a portfolio in a post go to its PortfolioRank page, not straight
// to the site (owner, 2026-11-12): readers land on /p/<url>, where we show
// the screenshot, the grade and the ranking, and that page links on to the
// site itself. Two places use this:
//
//   the writer   pipeline/content/engine.mjs stores a new post with every
//                [Name](site_url) of a portfolio in its fact sheet rewritten
//                to [Name](https://portfoliorank.n8builds.dev/p/<url>), after
//                the checks (which still see and load the real site_url);
//   rendering    components/blog/Markdown.tsx sends any link that matches a
//                portfolio we list to its page, so posts written before this
//                change link the same way, and a stored /p/ link whose
//                portfolio left the list goes to the site instead of a 404.
//
// Plain JavaScript: the engine, the app and the tests share it.

/** The site's own address (lib/site.ts SITE_URL), repeated here for the engine. */
export const SITE_ORIGIN = "https://portfoliorank.n8builds.dev";

/**
 * A portfolio address reduced to what identifies it: no protocol, no
 * "www.", a lower-case host, no trailing slash, query or hash. Null for
 * anything that isn't an http(s) address.
 */
export function portfolioKey(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

/** Our page for a portfolio, as a path: /p/<the listed url, encoded>. */
export const portfolioPath = (listedUrl) => `/p/${encodeURIComponent(listedUrl)}`;

/**
 * A lookup from any spelling of a listed portfolio's address to the address
 * as we list it (the /p/ page's key). `urls` are the listed addresses.
 * @param {Iterable<string>} urls
 * @returns {Map<string, string>}
 */
export function portfolioIndex(urls) {
  const m = new Map();
  for (const url of urls) {
    const k = portfolioKey(url);
    if (k && !m.has(k)) m.set(k, String(url));
  }
  return m;
}

/**
 * Where a link in a post should go, given the index of listed portfolios:
 *   - a listed portfolio's site: its page on PortfolioRank (/p/...);
 *   - one of our /p/ pages for a portfolio no longer listed: the site itself;
 *   - anything else: unchanged.
 * Returns the address to use (a path for our own pages).
 * @param {string} url
 * @param {Map<string, string>} index
 */
export function portfolioHref(url, index) {
  const s = String(url);
  const ours = s.startsWith(`${SITE_ORIGIN}/p/`) ? s.slice(SITE_ORIGIN.length) : s.startsWith("/p/") ? s : null;
  if (ours) {
    let target;
    try {
      target = decodeURIComponent(ours.slice(3).split(/[?#]/)[0]);
    } catch {
      return ours;
    }
    const listed = index.get(portfolioKey(target) ?? "");
    if (listed) return portfolioPath(listed);
    return /^https?:\/\//.test(target) ? target : ours;
  }
  const listed = index.get(portfolioKey(s) ?? "");
  return listed ? portfolioPath(listed) : s;
}

/**
 * The writer's side: a post body with every Markdown link to one of `urls`
 * (the portfolios its fact sheet may name) pointing at that portfolio's
 * PortfolioRank page instead. Links elsewhere (sources, our own pages) and
 * bare addresses are left alone.
 * @param {string} markdown
 * @param {Iterable<string>} urls
 */
export function linkPortfoliosToPages(markdown, urls) {
  const index = portfolioIndex(urls);
  if (!index.size) return String(markdown ?? "");
  return String(markdown ?? "").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (all, label, url) => {
    // "([source](url))" is a citation of an outside claim: it keeps its address.
    const listed = /^source$/i.test(label) ? null : index.get(portfolioKey(url) ?? "");
    return listed ? `[${label}](${SITE_ORIGIN}${portfolioPath(listed)})` : all;
  });
}
