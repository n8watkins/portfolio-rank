import { Leaderboard } from "@/components/top/Leaderboard";
import { loadLeaderboard } from "@/lib/leaderboard";

// Rendered at most once every 5 minutes (ISR) instead of on every visit: the
// tiers are placed again hourly, and every render costs database reads
// (Turso bills every row scanned; docs/COSTS.md section C).
export const revalidate = 300;

export const metadata = {
  title: "Leaderboard - PortfolioRank",
  description: "The best developer portfolios, ranked by ELO from face-off votes.",
};

/** The ranked board: tiers by ELO from face-offs (lib/tiers.mjs). */
export default async function TopPage() {
  return <Leaderboard board={await loadLeaderboard("rank")} views={false} />;
}
