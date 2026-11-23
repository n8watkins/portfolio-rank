export const SITE = {
  name: "PortfolioRank",
  tagline: "The best developer portfolios. Ranked.",
  github: "https://github.com/n8watkins/portfolio-rank",
  githubRepo: "n8watkins/portfolio-rank",
  kofi: "https://ko-fi.com/n8watkins",
  n8builds: "https://n8builds.dev",
  submit:
    "https://github.com/n8watkins/portfolio-rank/issues/new?template=submit-portfolio.yml",
  remove:
    "https://github.com/n8watkins/portfolio-rank/issues/new?template=remove-portfolio.yml",
} as const;

// The site's public address: the `SITE_URL` variable in wrangler.jsonc. The
// running Worker reads it with siteUrl(); pages built ahead of time use
// SITE_URL below, and tests/site-url.test.mjs keeps the two equal. Canonical, Open Graph and Twitter URLs, structured data, the
// sitemap, robots.txt, RSS, email links, the origin and Turnstile checks and
// Auth.js's callback URL (auth.ts) all come from it. Any other host the
// Worker answers is redirected here (worker/canonical-host.ts).
export const PRODUCTION_SITE_URL = "https://portfoliorank.dev";

/**
 * Other hosts the Worker answers only to redirect them to SITE_URL:
 * production's address before portfoliorank.dev (until 2026-11) and www.
 * Links already written with them (blog posts' data links) still count as
 * the site's own, and so do links to the retired staging site's first
 * address (staging.portfoliorank.n8builds.dev).
 */
export const OLD_SITE_HOSTS: readonly string[] = ["portfoliorank.n8builds.dev", "www.portfoliorank.dev", "staging.portfoliorank.n8builds.dev"];

/** The site's address as built. */
export const SITE_URL = PRODUCTION_SITE_URL;
/** SITE_URL's host ("portfoliorank.dev"), as share cards and printed reports show it. */
export const SITE_HOST = new URL(SITE_URL).host;

/**
 * The address of the Worker (or local server) answering now: the `SITE_URL`
 * variable, else the built-in SITE_URL. Never ends in a slash.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.SITE_URL || SITE_URL).replace(/\/+$/, "");
}

/** A link to this site as a path ("/top"), on SITE_URL or an old host; any other link unchanged. */
export function sitePath(link: string): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return link;
  }
  if (u.protocol !== "https:" || (u.origin !== new URL(SITE_URL).origin && !OLD_SITE_HOSTS.includes(u.hostname))) return link;
  return `${u.pathname}${u.search}${u.hash}`;
}

// Cloudflare Turnstile's public site key (widget "PortfolioRank", managed
// mode; its secret is TURNSTILE_SECRET_KEY on the Workers, lib/turnstile.ts).
// Public by design. NEXT_PUBLIC_TURNSTILE_SITE_KEY can swap in one of
// Cloudflare's test keys for local runs.
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "0x4AAAAAAF8GDSY7kmBfRpoD";
