import { notFound, redirect } from "next/navigation";
import { rankingViewsEnabled } from "@/lib/leaderboard";

// The old AI and People views of the leaderboard. RANKING_V2 now shows tiers
// by ELO on one ranked board at /top, so these lead there; with the flag off
// they don't exist, as before.
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
  // Tiers by ELO tell one story: the ranked board at /top (the views stay in /api/leaderboard).
  redirect("/top");
}
