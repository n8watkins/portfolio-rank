import { AppShell } from "@/components/shell/AppShell";
import { GradeProgress } from "@/components/preview/GradeProgress";
import { Queued } from "@/components/preview/YourPortfolio";
import { EmailReport } from "@/components/preview/EmailReport";
import { FaceOffTeaser } from "@/components/preview/HomeCards";
import { sampleVisitorSite } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grading - PortfolioRank" };

export default async function GradePage({ searchParams }: { searchParams: Promise<{ state?: string; url?: string; status?: string; mailed?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const queued = sp.status === "queued" || (v.queued && !sp.url);
  return (
    <AppShell visitor={v} current="grade">
      {queued ? (
        <div className="mx-auto flex max-w-2xl py-10 sm:py-14">
          <Queued standalone />
        </div>
      ) : (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5 py-10 sm:py-14">
          <div className="rise flex">
            <GradeProgress url={sp.url ?? "yourname.dev"} reportHref={`/grade/${sampleVisitorSite().slug}`} />
          </div>
          <div className="rise grid grid-cols-1 gap-5" style={{ "--d": "80ms" } as React.CSSProperties}>
            <EmailReport
              domain={(sp.url ?? "yourname.dev").replace(/^https?:[/][/]/, "")}
              reportHref={`/grade/${sampleVisitorSite().slug}`}
              initialSent={sp.mailed ? "you@example.com" : null}
            />
            <FaceOffTeaser />
          </div>
        </div>
      )}
    </AppShell>
  );
}
