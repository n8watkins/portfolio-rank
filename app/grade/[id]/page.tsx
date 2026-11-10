import { notFound } from "next/navigation";
import { ArrowRight, Bot, CircleCheck, CircleX, ExternalLink, Ruler, Trophy } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { Shot } from "@/components/preview/Shot";
import { ReportActions } from "@/components/preview/ReportActions";
import { SampleTag, TierBadge, card } from "@/components/preview/bits";
import { leaderboard, report, sampleVisitorSite, siteBySlug } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const site = siteBySlug((await params).id);
  return { title: site ? `${site.domain} - grade report - PortfolioRank` : "Report not found - PortfolioRank" };
}

function Dots({ value }: { value: number }) {
  return (
    <span className="flex gap-1" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`h-1.5 w-4 rounded-full ${i <= value ? "bg-accent" : "bg-edge"}`} />
      ))}
    </span>
  );
}

export default async function GradeReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  const site = siteBySlug((await params).id);
  if (!site) notFound();
  const rep = report(site);
  const listed = leaderboard("merged").find((r) => r.url === site.url);
  const yours = site.url === sampleVisitorSite().url;
  // On the leaderboard: everyone graded in the pool is, except "yours" for an unlisted visitor.
  const onBoard = yours ? v.listed : !!listed;

  return (
    <AppShell visitor={v} current={yours ? "grade" : "other"}>
      <div className="py-8 sm:py-10">
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          Grade report {(!rep.grade.real || yours) && <SampleTag what={yours ? "Sample visitor" : "Sample grade"} />}
        </p>

        {/* Screenshot and the overall tier */}
        <section aria-labelledby="overall" className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className={`${card} rise overflow-hidden`}>
            <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} eager className="aspect-[16/10] w-full" />
          </div>
          <div className={`${card} rise flex flex-col p-5 sm:p-6`} style={{ "--d": "80ms" } as React.CSSProperties}>
            <h1 id="overall" className="text-2xl font-bold tracking-tight">
              {site.name}
            </h1>
            <a href={site.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-sm text-mute hover:text-accent">
              {site.domain} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            <div className="mt-6 flex items-center gap-4">
              <TierBadge tier={rep.grade.tier} size="lg" />
              <div>
                <p className="text-sm text-mute">Overall</p>
                <p className="text-xl font-bold tracking-tight">Tier {rep.grade.tier}, about top {rep.est.topPct}%</p>
              </div>
            </div>
            <p className="mt-4 text-[15px]">
              Would rank around <strong className="tabular-nums">#{rep.est.rank.toLocaleString()}</strong> of {rep.est.total.toLocaleString()} portfolios.
            </p>
            {onBoard && listed && (
              <p className="mt-1 text-sm text-mute">
                On the leaderboard: <a href="/top" className="font-semibold text-ink hover:text-accent">#{listed.rank} merged</a> · #{listed.aiRank} AI · #{listed.peopleRank} people <SampleTag />
              </p>
            )}
            <p className="mt-auto pt-5 text-xs text-mute">
              Graded {rep.gradedOn}. Grades are estimates of the page, not a verdict on the developer.
            </p>
          </div>
        </section>

        {/* Facts and AI judgment, visibly separate */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section aria-labelledby="facts" className={`${card} reveal flex flex-col p-5 sm:p-6`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="facts" className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <Ruler className="h-5 w-5 text-mute" aria-hidden /> Measured facts
                </h2>
                <p className="mt-1 text-sm text-mute">Checked by code. Pass or fail, no opinion.</p>
              </div>
              <SampleTag />
            </div>
            <ul className="mt-4 divide-y divide-edge">
              {rep.facts.map((f) => (
                <li key={f.label} className="flex items-center gap-3 py-2.5">
                  {f.pass ? <CircleCheck className="h-5 w-5 shrink-0 text-up" aria-label="Pass" /> : <CircleX className="h-5 w-5 shrink-0 text-down" aria-label="Fail" />}
                  <a href={`/how#${f.criterion}`} className="min-w-0 flex-1 text-sm font-medium hover:text-accent">
                    {f.label}
                  </a>
                  <span className="truncate text-right text-sm text-mute">{f.detail}</span>
                </li>
              ))}
            </ul>
            <p className="mt-auto flex items-center justify-between gap-3 border-t border-edge pt-4 text-sm">
              <span className="text-mute">Checked {rep.gradedOn}</span>
              <span className="font-semibold tabular-nums">
                {rep.facts.filter((f) => f.pass).length} of {rep.facts.length} passed
              </span>
            </p>
          </section>

          <section aria-labelledby="ai" className={`${card} reveal p-5 sm:p-6`} style={{ "--d": "80ms" } as React.CSSProperties}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="ai" className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <Bot className="h-5 w-5 text-mute" aria-hidden /> AI judgment
                </h2>
                <p className="mt-1 text-sm text-mute">
                  Gemini&apos;s opinion of the page{rep.grade.real ? ` (${rep.grade.model})` : ""}, 1 to 5. Notes are sample text.
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute">Gemini</span>
            </div>
            <ul className="mt-4 divide-y divide-edge">
              {rep.subs.map((s) => (
                <li key={s.label} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <a href={`/how#${s.criterion}`} className="min-w-0 flex-1 text-sm font-medium hover:text-accent">
                      {s.label}
                    </a>
                    <Dots value={s.value} />
                    <span className="w-8 text-right text-sm font-semibold tabular-nums">
                      {s.value}
                      <span className="text-mute">/5</span>
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-mute">{s.note}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Top 3 improvements */}
        <section aria-labelledby="improve" className={`${card} reveal mt-5 p-5 sm:p-6`}>
          <h2 id="improve" className="text-lg font-bold tracking-tight">
            Fix these first
          </h2>
          <ol className={`mt-4 grid grid-cols-1 gap-3 ${["", "", "md:grid-cols-2", "md:grid-cols-3"][rep.improvements.length]}`}>
            {rep.improvements.map((m, i) => (
              <li key={m.title} className="flex gap-3 rounded-xl bg-raised p-4">
                <span className="grid grid-cols-1 h-7 w-7 shrink-0 place-items-center rounded-full bg-fill text-sm font-bold text-on-fill">{i + 1}</span>
                <div className="min-w-0">
                  <p className="font-semibold leading-snug">{m.title}</p>
                  <p className="mt-1 text-sm text-mute">{m.why}</p>
                  <a href={`/how#${m.criterion}`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">
                    The criterion <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Actions */}
        <section id="join" aria-label="What next" className="mt-5 scroll-mt-24">
          <ReportActions onBoard={onBoard} subscribed={v.subscribed} />
          {!onBoard && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-mute">
              <Trophy className="h-3.5 w-3.5" aria-hidden /> On the leaderboard, people vote on it in face-offs. You can leave any time.
            </p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
