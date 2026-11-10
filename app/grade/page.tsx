import { AppShell } from "@/components/shell/AppShell";
import { GradeProgress } from "@/components/preview/GradeProgress";
import { Queued } from "@/components/preview/YourPortfolio";
import { sampleVisitorSite } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grading - PortfolioRank" };

export default async function GradePage({ searchParams }: { searchParams: Promise<{ state?: string; url?: string; status?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const queued = sp.status === "queued" || (v.queued && !sp.url);
  return (
    <AppShell visitor={v} current="grade">
      <div className="mx-auto max-w-2xl py-10 sm:py-14">
        {queued ? <Queued standalone /> : <GradeProgress url={sp.url ?? "yourname.dev"} reportHref={`/grade/${sampleVisitorSite().slug}`} />}
      </div>
    </AppShell>
  );
}
