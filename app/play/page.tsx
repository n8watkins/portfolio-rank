import { PlayPage } from "@/components/preview/PlayPage";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Play - PortfolioRank" };

export default async function Play({ searchParams }: { searchParams: Promise<{ state?: string; mode?: string; reveal?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  return <PlayPage v={v} mode={sp.mode === "guess" ? "guess" : "faceoff"} reveal={!!sp.reveal} />;
}
