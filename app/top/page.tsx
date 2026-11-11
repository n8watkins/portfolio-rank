import { Leaderboard } from "@/components/top/Leaderboard";
import { loadLeaderboard, rankingViewsEnabled } from "@/lib/leaderboard";

// Rendered at most once every 5 minutes (ISR) instead of on every visit: the
// board changes once a night (ranking views) or slowly (ELO), and every
// render costs database reads (Turso bills every row scanned; docs/COSTS.md
// section C).
export const revalidate = 300;

export const metadata = {
  title: "Leaderboard - PortfolioRank",
  description: "The best developer portfolios, ranked by people's face-off votes and an AI grade.",
};

/** The Merged view when the ranking views are on (RANKING_V2), else today's ELO board. */
export default async function TopPage() {
  return <Leaderboard board={await loadLeaderboard(rankingViewsEnabled() ? "merged" : "elo")} />;
}
