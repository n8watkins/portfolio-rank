import { Bot, Merge, Split, Users } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { fmtScore, rankLabel } from "@/components/preview/RankRow";
import { Movement, SampleTag, TierBadge, card } from "@/components/preview/bits";
import { hasRealGrades, leaderboard, type Ranked, type View } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leaderboard - PortfolioRank" };

const VIEWS: { key: View; label: string; Icon: typeof Bot; blurb: string }[] = [
  { key: "merged", label: "Merged", Icon: Merge, blurb: "People's votes and the AI grade, weighted together." },
  { key: "ai", label: "AI", Icon: Bot, blurb: "Gemini's grade of design, first impression, project stories, writing and memorability." },
  { key: "people", label: "People", Icon: Users, blurb: "Head-to-head face-off votes, as an ELO rating." },
];

function Band({ r, view, min, max }: { r: Ranked; view: View; min: number; max: number }) {
  const span = max - min || 1;
  const lo = ((r.score - r.band - min) / span) * 100;
  const hi = ((r.score + r.band - min) / span) * 100;
  const mid = ((r.score - min) / span) * 100;
  return (
    <div className="hidden w-32 shrink-0 md:block" aria-hidden>
      <div className="relative h-1.5 rounded-full bg-raised">
        {view !== "ai" && (
          <div
            className={`absolute inset-y-0 rounded-full ${view === "people" ? "bg-people/35" : "bg-accent/35"}`}
            style={{ left: `${Math.max(0, lo)}%`, right: `${Math.max(0, 100 - hi)}%` }}
          />
        )}
        <div
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card ${view === "people" ? "bg-people" : view === "ai" ? "bg-ai" : "bg-accent"}`}
          style={{ left: `${Math.min(100, Math.max(0, mid))}%` }}
        />
      </div>
    </div>
  );
}

export default async function TopPage({ searchParams }: { searchParams: Promise<{ state?: string; view?: string; n?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const view: View = sp.view === "ai" || sp.view === "people" ? sp.view : "merged";
  const all = leaderboard(view);
  const limit = Math.min(all.length, Number(sp.n) || 50);
  const rows = all.slice(0, limit);
  const max = rows[0].score + rows[0].band;
  const min = rows[rows.length - 1].score - rows[rows.length - 1].band;
  const meta = VIEWS.find((x) => x.key === view)!;
  const sampleView = view !== "ai" || !hasRealGrades();

  return (
    <AppShell visitor={v} current="top">
      <div className="py-8 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-mute">
              {meta.blurb} {sampleView && <SampleTag what={`${meta.label} ranking`} />}
            </p>
          </div>
          <nav aria-label="Leaderboard view" className="inline-flex rounded-lg bg-raised p-1">
            {VIEWS.map(({ key, label, Icon }) => (
              <a
                key={key}
                href={`/top?view=${key}`}
                aria-current={view === key ? "page" : undefined}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-sm"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </a>
            ))}
          </nav>
        </div>

        <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-mute" aria-label="How to read this">
          <li>
            <strong className="font-semibold text-ink">=3</strong> equal scores share a place
          </li>
          {view !== "ai" && (
            <li className="flex items-center gap-1.5">
              <span className={`inline-block h-1.5 w-6 rounded-full ${view === "people" ? "bg-people/35" : "bg-accent/35"}`} aria-hidden /> how sure we are; overlapping bands are near-equal
            </li>
          )}
          {view !== "ai" && (
            <li className="flex items-center gap-1">
              <Movement move={2} /> places this week
            </li>
          )}
          <li className="flex items-center gap-1">
            <Split className="h-3.5 w-3.5 text-ai" aria-hidden /> AI and people strongly disagree
          </li>
        </ul>

        <div className={`${card} mt-4 overflow-hidden`}>
          <div className="hidden items-center gap-4 border-b border-edge px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-mute md:flex">
            <span className="w-10 text-right">#</span>
            <span className="w-24">Site</span>
            <span className="flex-1" />
            {view !== "ai" && <span className="w-10 text-right">Week</span>}
            <span className="w-32">{view === "ai" ? "Score" : "Score and range"}</span>
            <span className="w-20 text-right">{view === "people" ? "ELO" : "Score"}</span>
          </div>
          <ol>
            {rows.map((r) => (
              <li key={r.url} className="border-b border-edge last:border-b-0">
                <a href={`/grade/${r.slug}`} className="flex items-center gap-3 px-3 py-2.5 transition hover:bg-raised md:gap-4 md:px-4">
                  <span className={`w-9 shrink-0 text-right text-sm font-bold tabular-nums md:w-10 ${r.rank <= 3 ? "text-accent" : "text-mute"}`}>{rankLabel(r)}</span>
                  <Shot base={r.shot} alt="" domain={r.domain} className="aspect-[16/10] w-12 shrink-0 rounded-md border border-edge sm:w-16 md:w-24" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      {r.disagree && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ai-soft px-1.5 py-0.5 text-[11px] font-semibold text-ai"
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
                  {view !== "ai" && <Movement move={r.move} className="hidden w-10 justify-end md:inline-flex" />}
                  <Band r={r} view={view} min={min} max={max} />
                  <span className="w-14 shrink-0 text-right md:w-20">
                    <span className="block text-sm font-bold tabular-nums">{fmtScore(view, r.score)}</span>
                    {view !== "ai" ? (
                      <span className="block text-[11px] text-mute tabular-nums">±{r.band}</span>
                    ) : (
                      <span className="mt-0.5 flex justify-end">
                        <span className="sr-only">Tier</span>
                        <TierBadge tier={r.grade!.tier} size="md" />
                      </span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </div>
        {limit < all.length && (
          <div className="mt-5 text-center">
            <a href={`/top?view=${view}&n=${limit + 50}`} className="inline-flex h-10 items-center rounded-lg border border-edge px-4 text-sm font-semibold transition hover:border-mute">
              Show 50 more
            </a>
          </div>
        )}
      </div>
    </AppShell>
  );
}
