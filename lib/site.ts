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
