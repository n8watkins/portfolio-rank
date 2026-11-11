import { notFound } from "next/navigation";
import { ArrowRight, Bot, Briefcase, ExternalLink, PartyPopper, Rocket, Sparkles, TrendingUp, Wrench } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { ReportCta } from "@/components/preview/ReportCta";
import { HiringView } from "@/components/preview/HiringView";
import { RankBadge, SampleTag, TierBadge } from "@/components/preview/bits";
import { doingBetter, leaderboard, recommendations, report, sampleVisitorSite, scorecard, similarTo, siteBySlug, topPct } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const site = siteBySlug((await params).id);
  return { title: site ? `${site.domain} - grade report - PortfolioRank` : "Report not found - PortfolioRank" };
}

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

export default async function GradeReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ state?: string; pdf?: string; empty?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const site = siteBySlug((await params).id);
  if (!site) notFound();
  const rep = report(site);
  const raw = scorecard(site.url);
  // The ?empty=1 preview shows a site with nothing left to fix, facts included.
  const card = sp.empty ? { ...raw, facts: raw.facts.map((f) => ({ ...f, pass: true, detail: f.pass ? f.detail : "Passes" })) } : raw;
  // ?empty=1 previews the "nothing urgent to fix" state.
  const recs = sp.empty ? [] : recommendations(site);
  const board = leaderboard("merged");
  const listed = board.find((r) => r.url === site.url);
  const yours = site.url === sampleVisitorSite().url;
  const onBoard = yours ? v.listed : !!listed;
  const pct = listed ? topPct(listed.rank, board.length) : rep.est.topPct;
  const better = listed ? doingBetter(site.url) : [];
  const similar = listed ? similarTo(site.url) : board.slice(200, 204);

  return (
    <AppShell visitor={v} current={yours ? "grade" : "other"}>
      <div className="py-8 sm:py-10">
        {/* The result first */}
        <section aria-labelledby="overall" className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="card card-featured rise overflow-hidden">
            <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} eager className="aspect-[16/10] w-full lg:aspect-auto lg:h-full" />
          </div>
          <div className="card rise flex flex-col p-6 sm:p-8" style={d(80)}>
            <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
              Grade report {(!rep.grade.real || yours) && <SampleTag what={yours ? "Sample visitor" : "Sample grade"} />}
            </p>
            <h1 id="overall" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              {site.name}
            </h1>
            <a href={site.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex w-fit items-center gap-1 text-sm text-mute hover:text-accent">
              {site.domain} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>

            <div className="mt-6 flex items-center gap-5">
              <span className="pop-in">
                <TierBadge tier={rep.grade.tier} size="lg" />
              </span>
              <div>
                <p className="text-5xl font-bold leading-none tracking-tight sm:text-6xl">
                  Top {pct}
                  <span className="text-3xl sm:text-4xl">%</span>
                </p>
                <p className="mt-1.5 text-sm text-mute">
                  of {board.length} graded portfolios
                  {listed ? ` · #${listed.rank} merged` : ` · would be about #${rep.est.rank}`}
                </p>
              </div>
            </div>
            <p className="mt-5 text-lg font-medium text-pretty">{card.verdict}</p>
            <p className="mt-1 text-xs text-mute">Graded {rep.gradedOn}. A grade describes the page, not the developer.</p>

            <div id="join" className="mt-auto scroll-mt-24 pt-6">
              <ReportCta onBoard={onBoard} subscribed={v.subscribed} signedIn={v.signedIn} domain={site.domain} reportHref={`/grade/${site.slug}`} pdfOpen={!!sp.pdf} />
            </div>
          </div>
        </section>

        {/* What a hiring manager sees, and how it looks and reads */}
        {/* Each card is as tall as its content, so neither shows an empty band. */}
        <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section aria-labelledby="hiring" className="card reveal p-5 sm:p-6">
            <h2 id="hiring" className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <Briefcase className="h-4 w-4 text-mute" aria-hidden /> What a hiring manager sees
            </h2>
            <p className="mt-1 text-sm text-mute">Checked by code on {rep.gradedOn}. Sample facts in this preview.</p>
            <div className="mt-4">
              <HiringView facts={card.facts} />
            </div>
          </section>
          <section aria-labelledby="ai" className="card reveal p-5 sm:p-6" style={d(80)}>
            <h2 id="ai" className="flex items-center justify-between gap-2 text-lg font-bold tracking-tight">
              <span className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-mute" aria-hidden /> How it looks and reads
              </span>
              <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute">Gemini</span>
            </h2>
            <p className="mt-1 text-sm text-mute">Judged from one screenshot and the page text, 1 to 5.</p>
            <ul className="mt-4 divide-y divide-edge">
              {card.subs.map((s) => (
                <li key={s.label} className="py-3">
                  <div className="flex items-center gap-3">
                    <a href={`/about#grading`} className="min-w-0 flex-1 text-sm font-semibold hover:text-accent">
                      {s.label}
                    </a>
                    <span className="flex gap-1" aria-hidden>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <span key={i} className={`h-1.5 w-5 rounded-full ${i <= s.value ? "bg-fill" : "bg-edge"}`} />
                      ))}
                    </span>
                    <span className="w-8 text-right text-sm font-semibold tabular-nums">
                      {s.value}
                      <span className="text-mute">/5</span>
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-mute">{s.note}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* What to do next */}
        <section aria-labelledby="improve" className="card reveal mt-5 p-5 sm:p-6">
          {recs.length > 0 ? (
            <>
              <h2 id="improve" className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <Wrench className="h-4 w-4 text-mute" aria-hidden /> Fix these first
              </h2>
              <ol className={`mt-4 grid grid-cols-1 gap-3 ${recs.length >= 3 ? "md:grid-cols-3" : recs.length === 2 ? "md:grid-cols-2" : ""}`}>
                {recs.map((m, i) => (
                  <li key={m.title} className={`flex gap-3 rounded-xl p-4 ${i === 0 ? "border border-accent/40 bg-accent-soft" : "bg-raised"}`}>
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fill text-sm font-bold text-on-fill">{i + 1}</span>
                    <span className="min-w-0 text-sm">
                      {i === 0 && <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-accent">Biggest win</span>}
                      <span className="block font-semibold">{m.title}</span>
                      <span className="mt-0.5 block text-mute">{m.why}</span>
                      <span className="mt-1.5 block">
                        <span className="text-mute">Expected:</span> {m.effect}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <span className="icon-tile h-12 w-12 shrink-0">
                <PartyPopper className="icon-twinkle h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="improve" className="text-lg font-bold tracking-tight">
                  Nothing urgent to fix
                </h2>
                <p className="mt-1 text-sm text-mute">Every check passes and every score is high. To climb further:</p>
                <ul className="mt-2 grid gap-1 text-sm">
                  <li>Get it into more face-offs: people&apos;s votes are what moves the merged rank now.</li>
                  <li>Re-grade after each big change, so the report keeps up.</li>
                </ul>
              </div>
              <a href="/play" className="btn-sheen inline-flex h-11 shrink-0 items-center gap-2 rounded-lg px-5 text-sm font-semibold">
                <Rocket className="h-4 w-4" aria-hidden /> Play a face-off
              </a>
            </div>
          )}
        </section>

        {/* Learn from the ones above */}
        {better.length > 0 && (
          <section aria-labelledby="better" className="reveal mt-12">
            <h2 id="better" className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <TrendingUp className="h-5 w-5 text-accent" aria-hidden /> Portfolios doing it better
            </h2>
            <p className="mt-1 text-sm text-mute">Ranked above this one, each with the thing it does better. Sample comparison.</p>
            {better.length === 1 ? (
              // One site: a smaller shot beside a centred text block with its own actions.
              <div className="card mt-5 grid grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <a href={`/grade/${better[0].r.slug}`} className="group block overflow-hidden border-edge max-md:border-b md:border-r">
                  <Shot base={better[0].r.shot} alt={`Screenshot of ${better[0].r.domain}`} domain={better[0].r.domain} className="aspect-[16/10] h-full w-full transition duration-500 group-hover:scale-[1.02]" />
                </a>
                <div className="flex flex-col justify-center p-5 sm:p-7">
                  <p className="flex items-center gap-2.5">
                    <RankBadge rank={better[0].r.rank} />
                    <span className="min-w-0">
                      <span className="block truncate text-lg font-semibold">{better[0].r.name}</span>
                      <span className="block text-xs text-mute tabular-nums">
                        #{better[0].r.rank} merged · Top {topPct(better[0].r.rank, board.length)}%
                      </span>
                    </span>
                  </p>
                  <p className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden /> Better {better[0].label.toLowerCase()}: {better[0].theirs} vs {better[0].yours}
                  </p>
                  <p className="mt-2 text-[15px] text-mute">{better[0].note}</p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <a href={`/grade/${better[0].r.slug}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-edge bg-card px-3.5 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
                      See its report
                    </a>
                    <a href={better[0].r.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-edge bg-card px-3.5 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Visit
                    </a>
                    <a href={`/play?with=${encodeURIComponent(better[0].r.slug)}`} className="group btn-sheen inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold">
                      Compare in a face-off <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
                    </a>
                  </div>
                </div>
              </div>
            ) : (
            <div className={`mt-5 grid grid-cols-1 gap-5 ${better.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
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
            </div>
            )}
          </section>
        )}

        <section aria-labelledby="similar" className="reveal mt-12">
          <h2 id="similar" className="text-2xl font-bold tracking-tight">
            Similar portfolios
          </h2>
          <p className="mt-1 text-sm text-mute">Ranked close to this one: good company to compare with.</p>
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

        <p className="mt-10 text-center print:hidden">
          <a href="/play" className="group inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
            Think you can spot a top 10% portfolio? Play a round <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </a>
        </p>
      </div>
    </AppShell>
  );
}
