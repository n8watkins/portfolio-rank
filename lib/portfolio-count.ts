import feed from "@/data/feed.json";

// Server-only (it reads the whole list): pass the label down to client components.

/** How many portfolios the list holds, rounded down for copy: "2,100+". */
export const PORTFOLIO_COUNT_LABEL = `${(Math.floor(feed.length / 100) * 100).toLocaleString("en-US")}+`;
