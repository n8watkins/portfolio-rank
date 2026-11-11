import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { PortfolioGrid } from "@/components/PortfolioGrid";
import { FAQ } from "@/components/FAQ";
import { AI_JUDGES } from "@/lib/rubric-copy";
import { hiddenUrls } from "@/lib/roster";

// Every listed portfolio, searchable and filterable (the grid that used to
// sit on home). Re-rendered at most every 5 minutes (ISR).
export const revalidate = 300;

export const metadata = {
  title: "Browse - PortfolioRank",
};

export default async function BrowsePage() {
  // Sites confirmed down or failing are hidden (lib/roster.hiddenUrls), as
  // on the voting pool and the leaderboards.
  const hidden = await hiddenUrls();
  const portfolios = (feed as Portfolio[]).filter((p) => !hidden.has(p.url));
  return (
    <div className="wrap py-10 sm:py-14">
      {/* The grid's own toolbar names the page; this is for screen readers and the outline. */}
      <h1 className="sr-only">
        Browse {portfolios.length.toLocaleString("en-US")} portfolios
      </h1>
      <PortfolioGrid portfolios={portfolios} />
      <FAQ aiJudges={AI_JUDGES} />
    </div>
  );
}
