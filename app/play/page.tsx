import { PlayPage } from "@/components/preview/PlayPage";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Play - PortfolioRank" };

export default async function Play({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; mode?: string; quiz?: string; reveal?: string; end?: string; details?: string; with?: string }>;
}) {
  const sp = await searchParams;
  const v = await visitor(sp);
  return (
    <PlayPage
      v={v}
      mode={sp.mode === "guess" ? "guess" : "faceoff"}
      quiz={sp.quiz}
      preset={sp.end ? "end" : sp.reveal ? "reveal" : undefined}
      details={sp.details === "advanced" ? "advanced" : sp.details === "simple" ? "simple" : undefined}
      withSlug={sp.with}
    />
  );
}
