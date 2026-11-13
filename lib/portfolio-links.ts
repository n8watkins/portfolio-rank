import feed from "@/data/feed.json";
import { portfolioHref, portfolioIndex } from "@/lib/content/portfolio-links.mjs";

// The app's side of lib/content/portfolio-links.mjs: the portfolios we list
// (data/feed.json, the same list /p/[slug] answers for), so a post's link to
// one of them opens its PortfolioRank page.

let index: Map<string, string> | null = null;
const listed = () => (index ??= portfolioIndex((feed as { url: string }[]).map((p) => p.url)));

/** Where a link in a post goes: a listed portfolio's PortfolioRank page, else the address itself. */
export const postLinkFor = (url: string): string => portfolioHref(url, listed());
