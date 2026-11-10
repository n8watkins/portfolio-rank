import { notFound } from "next/navigation";
import { ArrowRight, CircleCheck, ExternalLink, Sparkles, ThumbsUp, TrendingUp, Wrench } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { ReportActions } from "@/components/preview/ReportActions";
import { DownloadReport } from "@/components/preview/DownloadReport";
import { ScorecardPanel } from "@/components/preview/ScorecardPanel";
import { RankBadge, SampleTag, TierBadge } from "@/components/preview/bits";
import { doingBetter, leaderboard, report, sampleVisitorSite, scorecard, similarTo, siteBySlug, topPct } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const site = siteBySlug((await params).id);
  return { title: site ? `${site.domain} - grade report - PortfolioRank` : "Report not found - PortfolioRank" };
}

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

export default async function GradeReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ state?: string; pdf?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const site = siteBySlug((await params).id);
  if (!site) notFound();
  const rep = report(site);
  const card = scorecard(site.url);
  const board = leaderboard("merged");
  const listed = board.find((r) => r.url === site.url);
  const yours = site.url === sampleVisitorSite().url;
  const onBoard = yours ? v.listed : !!listed;
  const pct = listed ? topPct(listed.rank, board.length) : rep.est.topPct;
  const strengths = [
    ...card.subs.filter((s) => s.value >= 4).map((s) => ({ t: s.label, d: s.note })),
    ...card.facts.filter((f) => f.pass).map((f) => ({ t: f.label, d: f.detail })),
  ].slice(0, 4);
  const better = listed ? doingBetter(site.url) : [];
  const similar = listed ? similarTo(site.url) : board.slice(200, 204);

  return (
    <AppShell visitor={v} current={yours ? "grade" : "other"}>
      <div className="py-8 sm:py-10">
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          Grade report {(!rep.grade.real || yours) && <SampleTag what={yours ? "Sample visitor" : "Sample grade"} />}
        </p>

        {/* Header: the page, the tier, the percentile */}
        <section aria-labelledby="overall" className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="card card-featured rise overflow-hidden">
            <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} eager className="aspect-[16/10] w-full" />
          </div>
          <div className="card rise flex flex-col p-6 sm:p-7" style={d(80)}>
            <h1 id="overall" className="text-3xl font-bold tracking-tight">
              {site.name}
            </h1>
            <a href={site.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-sm text-mute hover:text-accent">
              {site.domain} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-edge bg-bg/40 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-mute">AI tier</p>
                <div className="mt-2 flex items-center gap-3">
                  <TierBadge tier={rep.grade.tier} size="lg" />
                  <p className="text-sm text-mute">{card.verdict}</p>
                </div>
              </div>
              <div className="rounded-xl border border-edge bg-bg/40 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-mute">Percentile</p>
                <p className="mt-2 text-4xl font-bold tracking-tight tabular-nums">
                  Top {pct}
                  <span className="text-2xl">%</span>
                </p>
                <p className="mt-1 text-sm text-mute">
                  {listed ? (
                    <span>
                      #{listed.rank} of {board.length} graded, merged view
                    </span>
                  ) : (
                    `Would be about #${rep.est.rank} of ${rep.est.total.toLocaleString()}`
                  )}
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-mute">Graded {rep.gradedOn}. A grade describes the page, not the developer.</p>
            <div id="join" className="mt-auto flex scroll-mt-24 flex-col gap-2 pt-5">
              <ReportActions onBoard={onBoard} subscribed={v.subscribed} />
              <DownloadReport signedIn={v.signedIn} domain={site.domain} reportHref={`/grade/${site.slug}`} initialOpen={!!sp.pdf} />
            </div>
          </div>
        </section>

        {/* Scorecard, strengths and fixes */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <section aria-label="Scorecard" className="card reveal p-5 sm:p-6">
            <h2 className="mb-4 text-lg font-bold tracking-tight">Scorecard</h2>
            <ScorecardPanel card={card} showTier={false} />
          </section>
          <div className="flex flex-col gap-5">
            <section aria-labelledby="strengths" className="card reveal p-5 sm:p-6" style={d(80)}>
              <h2 id="strengths" className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <ThumbsUp className="h-4 w-4 text-up" aria-hidden /> What works
              </h2>
              <ul className="mt-3 grid gap-2.5 text-sm">
                {strengths.map((s) => (
                  <li key={s.t} className="flex gap-2.5">
                    <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
                    <span>
                      <span className="font-semibold">{s.t}</span> <span className="text-mute">{s.d}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="improve" className="card reveal flex-1 p-5 sm:p-6" style={d(140)}>
              <h2 id="improve" className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <Wrench className="h-4 w-4 text-mute" aria-hidden /> Fix these first
              </h2>
              <ol className="mt-3 grid gap-3">
                {rep.improvements.map((m, i) => (
                  <li key={m.title} className="flex gap-3">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-xs font-bold text-on-fill">{i + 1}</span>
                    <span className="text-sm">
                      <span className="block font-semibold">{m.title}</span>
                      <span className="block text-mute">{m.why}</span>
                      <a href={`/about#${m.criterion}`} className="group mt-1 inline-flex items-center gap-1 font-semibold text-accent">
                        The criterion <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
                      </a>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>

        {/* Learn from the ones above */}
        {better.length > 0 && (
          <section aria-labelledby="better" className="reveal mt-12">
            <h2 id="better" className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <TrendingUp className="h-5 w-5 text-accent" aria-hidden /> Portfolios doing it better
            </h2>
            <p className="mt-1 text-sm text-mute">Ranked above this one, each with the thing it does better. Sample comparison.</p>
            <div className={`mt-5 grid grid-cols-1 gap-5 ${better.length === 1 ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
              {better.map((b) => (
                <a key={b.r.url} href={`/grade/${b.r.slug}`} className="card card-hover group flex flex-col overflow-hidden">
                  <Shot base={b.r.shot} alt="" domain={b.r.domain} className="aspect-[16/10] w-full border-b border-edge" />
                  <span className="flex flex-1 flex-col p-4">
                    <span className="flex items-center gap-2">
                      <RankBadge rank={b.r.rank} />
                      <span className="truncate font-semibold">{b.r.name}</span>
                    </span>
                    <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden /> Better {b.label.toLowerCase()}: {b.theirs} vs {b.yours}
                    </span>
                    <span className="mt-2 text-sm text-mute">{b.note}</span>
                  </span>
                </a>
              ))}
              {better.length < 3 && (
                <div className="card flex flex-col justify-center p-5 text-sm">
                  <p className="font-semibold">What the very top shares</p>
                  <ul className="mt-2 grid gap-1.5 text-mute">
                    <li>Projects told as problem, role and result.</li>
                    <li>Who they are and what they want, in the first screen.</li>
                    <li>Their own domain, a resume and working links.</li>
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        <section aria-labelledby="similar" className="reveal mt-12">
          <h2 id="similar" className="text-2xl font-bold tracking-tight">
            Similar portfolios
          </h2>
          <p className="mt-1 text-sm text-mute">Ranked close to this one.</p>
          <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {similar.map((r) => (
              <a key={r.url} href={`/grade/${r.slug}`} className="card card-hover group overflow-hidden">
                <Shot base={r.shot} alt="" domain={r.domain} className="aspect-[16/10] w-full border-b border-edge" />
                <span className="flex items-center gap-2 p-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{r.name}</span>
                    <span className="block text-xs text-mute tabular-nums">
                      #{r.rank} · Top {topPct(r.rank, board.length)}%
                    </span>
                  </span>
                  <TierBadge tier={r.grade!.tier} />
                </span>
              </a>
            ))}
          </div>
        </section>

      </div>
    </AppShell>
  );
}
