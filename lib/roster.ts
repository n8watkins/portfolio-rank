import feed from "@/data/feed.json";

const known = new Set((feed as { url: string }[]).map((p) => p.url));

/** True if the URL is an actual portfolio from the list. */
export function isKnownPortfolio(url: string): boolean {
  return known.has(url);
}
