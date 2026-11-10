import { Bot, Merge, Split, Users } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { fmtScore, rankLabel } from "@/components/preview/RankRow";
import { Movement, SampleTag, TierBadge } from "@/components/preview/bits";
import { hasRealGrades, leaderboard, type Ranked, type View } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leaderboard - PortfolioRank" };

const VIEWS: { key: View; label: string; Icon: typeof Bot; blurb: string }[] = [
  { key: "merged", label: "Merged", Icon: Merge, blurb: "People's votes and the AI grade, weighted together." },
  { key: "ai", label: "AI", Icon: Bot, blurb: "Gemini's grade of design, first impression, project stories, writing and memorability." },
  { key: "people", label: "People", Icon: Users, blurb: "Head-to-head face-off votes, as an ELO rating." },
];

function likelyLabel(r: Ranked) {
  const [lo, hi] = r.likely;
  return lo === hi ? "#" + lo : "#" + lo + "-#" + hi;
}

export default async function TopPage({ searchParams }: { searchParams: Promise<{ state?: string; view?: string; n?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const view: View = sp.view === "ai" || sp.view === "people" ? sp.view : "merged";
  const all = leaderboard(view);
  const limit = Math.min(all.length, Number(sp.n) || 50);
  const rows = all.slice(0, limit);
  const meta = VIEWS.find((x) => x.key === view)!;
  const sampleView = view !== "ai" || !hasRealGrades();

  return (
    <AppShell visitor={v} current="top">
      <div className="py-8 sm:py-10">
        <div className="rise flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-mute">
              {meta.blurb} {sampleView && <SampleTag what={`${meta.label} ranking`} />}
            </p>
          </div>
          <nav aria-label="Leaderboard view" className="inline-flex rounded-lg border border-edge bg-raised p-1">
            {VIEWS.map(({ key, label, Icon }) => (
              <a
                key={key}
                href={`/top?view=${key}`}
                aria-current={view === key ? "page" : undefined}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-[var(--card-hi),var(--card-drop)]"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </a>
            ))}
          </nav>
        </div>

        <ul className="rise mt-5 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-mute" style={{ "--d": "60ms" } as React.CSSProperties} aria-label="How to read this">
          <li>
            <strong className="font-semibold text-ink">=3</strong> equal scores share a place
          </li>
          <li>
            <strong className="font-semibold text-ink">{view === "ai" ? "Top 1%" : "Likely #2-#5"}</strong>{" "}
            {view === "ai" ? "share of graded portfolios at or above it" : "where it could land, given how many votes it has so far"}
          </li>
          {view !== "ai" && (
            <li className="flex items-center gap-1">
              <Movement move={2} /> places this week
            </li>
          )}
          <li className="flex items-center gap-1">
            <Split className="h-3.5 w-3.5" aria-hidden /> AI and people strongly disagree
          </li>
        </ul>

        <div className="card rise mt-4 overflow-hidden" style={{ "--d": "120ms" } as React.CSSProperties}>
          <div className="hidden items-center gap-4 border-b border-edge px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-mute md:flex" aria-hidden>
            <span className="w-10 text-right">#</span>
            <span className="flex-1">Portfolio</span>
            {view !== "ai" && <span className="w-12 text-right">Week</span>}
            {view === "ai" && <span className="w-12 text-center">Tier</span>}
            <span className="w-28 text-right">{view === "ai" ? "Percentile" : "Likely rank"}</span>
            <span className="w-16 text-right">{view === "people" ? "ELO" : "Score"}</span>
          </div>
          <ol>
            {rows.map((r) => (
              <li key={r.url} className="border-b border-edge last:border-b-0">
                <a href={`/grade/${r.slug}`} className="group flex items-center gap-3 px-3 py-2.5 transition hover:bg-raised md:gap-4 md:px-4">
                  <span className={`w-9 shrink-0 text-right text-sm font-bold tabular-nums md:w-10 ${r.rank <= 3 ? "text-accent" : "text-mute"}`}>{rankLabel(r)}</span>
                  <Shot base={r.shot} alt="" domain={r.domain} className="aspect-[16/10] w-16 shrink-0 rounded-md border border-edge max-sm:hidden md:w-24" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      {r.disagree && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-edge-strong px-1.5 py-0.5 text-[11px] font-medium text-mute"
                          title={`AI ranks it #${r.aiRank}, people rank it #${r.peopleRank}`}
                        >
                          <Split className="h-3 w-3" aria-hidden />
                          <span className="sr-only">AI and people disagree:</span>
                          <span className="hidden sm:inline">
                            AI #{r.aiRank} · People #{r.peopleRank}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-mute">{r.tagline ?? r.domain}</span>
                  </span>
                  {view !== "ai" && <Movement move={r.move} className="nudge-up hidden w-12 justify-end md:inline-flex" />}
                  {view === "ai" && (
                    <span className="hidden w-12 justify-center md:flex">
                      <TierBadge tier={r.grade!.tier} />
                    </span>
                  )}
                  <span className="hidden w-28 text-right text-sm tabular-nums text-mute md:block">
                    {view === "ai" ? `Top ${r.topPct}%` : likelyLabel(r)}
                  </span>
                  <span className="w-[4.75rem] shrink-0 text-right md:w-16">
                    <span className="block text-sm font-bold tabular-nums">
                      <span className="sr-only">{view === "people" ? "ELO " : "Score "}</span>
                      {fmtScore(view, r.score)}
                    </span>
                    <span className="block whitespace-nowrap text-[11px] text-mute tabular-nums md:hidden">
                      {view === "ai" ? `top ${r.topPct}%` : `likely ${likelyLabel(r).replace("-#", "-")}`}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </div>
        {limit < all.length && (
          <div className="mt-5 text-center">
            <a
              href={`/top?view=${view}&n=${limit + 50}`}
              className="inline-flex h-10 items-center rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong"
            >
              Show 50 more
            </a>
          </div>
        )}
      </div>
    </AppShell>
  );
}
