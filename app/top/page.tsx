import { Leaderboard } from "@/components/top/Leaderboard";
import { loadLeaderboard, rankingViewsEnabled } from "@/lib/leaderboard";
import { RankedBoard } from "@/components/tiers/RankedBoard";
import { loadRankedBoard } from "@/lib/tiers-board";

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
  // Tiers by ELO (RANKING_V2): one ranked board, the letter from the votes (lib/tiers-board.ts).
  if (rankingViewsEnabled()) return <RankedBoard board={await loadRankedBoard()} />;
  return <Leaderboard board={await loadLeaderboard(rankingViewsEnabled() ? "merged" : "elo")} />;
}
