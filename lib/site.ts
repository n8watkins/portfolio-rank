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

// The site's public address: canonical URLs, share links, the sitemap and
// robots.txt are built from it.
export const SITE_URL = "https://portfoliorank.n8builds.dev";

// Cloudflare Turnstile's public site key (widget "PortfolioRank", managed
// mode; its secret is TURNSTILE_SECRET_KEY on the Workers, lib/turnstile.ts).
// Public by design. NEXT_PUBLIC_TURNSTILE_SITE_KEY can swap in one of
// Cloudflare's test keys for local runs.
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "0x4AAAAAAF8GDSY7kmBfRpoD";

// True in the staging build (the deploy workflow sets NEXT_PUBLIC_SITE_ENV to
// "staging" for it; DEPLOY.md "Staging"): pages show a "Staging" ribbon and
// say noindex. Inlined at build time, so the prerendered home page has it too.
// The Worker adds robots.txt and the X-Robots-Tag header (worker/staging.ts).
export const IS_STAGING = process.env.NEXT_PUBLIC_SITE_ENV === "staging";
