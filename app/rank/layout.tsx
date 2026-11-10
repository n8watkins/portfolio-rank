import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rank portfolios - PortfolioRank",
  description: "Two developer portfolios, side by side: pick the better one. Your votes decide the leaderboard.",
};

export default function RankLayout({ children }: { children: React.ReactNode }) {
  return children;
}
