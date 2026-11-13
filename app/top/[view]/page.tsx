import { notFound, redirect } from "next/navigation";
import { rankingViewsEnabled } from "@/lib/leaderboard";

// The old Merged, AI and People views of the leaderboard. The site tells one
// story now (owner, 2026-11-12): the ranked board at /top, tiers by ELO from
// face-offs, graded only. Their old addresses lead there while the ranking
// views are on (RANKING_V2); the views themselves stay in the data
// (/api/leaderboard) and in Guess the percentile.
export const dynamicParams = false;

const VIEWS = ["merged", "ai", "people"];

export function generateStaticParams() {
  return VIEWS.map((view) => ({ view }));
}

export default async function TopViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (!rankingViewsEnabled() || !VIEWS.includes(view)) notFound();
  redirect("/top");
}
