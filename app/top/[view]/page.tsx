import { notFound } from "next/navigation";
import { Leaderboard } from "@/components/top/Leaderboard";
import { loadLeaderboard, rankingViewsEnabled } from "@/lib/leaderboard";

// The AI and People views of the leaderboard (/top is Merged), only while
// the ranking views are on (RANKING_V2). Cached like /top.
export const revalidate = 300;
export const dynamicParams = false;

const VIEWS = { ai: "AI", people: "People" } as const;

export function generateStaticParams() {
  return Object.keys(VIEWS).map((view) => ({ view }));
}

export async function generateMetadata({ params }: { params: Promise<{ view: keyof typeof VIEWS }> }) {
  const { view } = await params;
  return { title: `Leaderboard, ${VIEWS[view] ?? ""} view - PortfolioRank` };
}

export default async function TopViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (!rankingViewsEnabled() || (view !== "ai" && view !== "people")) notFound();
  return <Leaderboard board={await loadLeaderboard(view)} />;
}
