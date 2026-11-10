import feed from "@/data/feed.json";

// Server-only (it reads the whole list): pass the label down to client components.

/**
 * How many portfolios the list holds, rounded down to 500 for copy ("2,000+"):
 * some are hidden while their sites are down, so the count on show (the home
 * hero) is a little lower than the list and must not read as a contradiction.
 */
export const PORTFOLIO_COUNT_LABEL = `${(Math.floor(feed.length / 500) * 500).toLocaleString("en-US")}+`;
