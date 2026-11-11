import feed from "@/data/feed.json";

// Server-only (it reads the whole list): pass the label down to client components.

/**
 * How many portfolios the list holds, rounded down to 500 for copy ("2,000+"):
 * some are hidden while their sites are down, so the count on show (the home
 * hero) is a little lower than the list and must not read as a contradiction.
 */
/**
 * People who have added to the community list (emmabostian/developer-
 * portfolios), rounded down for copy. The live number is on GitHub; this
 * moves rarely, so it is set by hand.
 */
export const CONTRIBUTOR_COUNT_LABEL = "1,700+";

export const PORTFOLIO_COUNT_LABEL =`${(Math.floor(feed.length / 500) * 500).toLocaleString("en-US")}+`;
