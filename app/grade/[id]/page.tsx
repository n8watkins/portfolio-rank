import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bot, Briefcase, CircleAlert, CircleCheck, CircleMinus, ExternalLink, Link2Off, PartyPopper, Sparkles, Target, TrendingUp, Users, Wrench } from "lucide-react";
import { Celebration } from "@/components/grade/Celebration";
import { GradeForm } from "@/components/grade/GradeForm";
import { GradeProgress } from "@/components/grade/GradeProgress";
import { HiringView } from "@/components/grade/HiringView";
import { OwnerPanel } from "@/components/grade/OwnerPanel";
import { PrintReport } from "@/components/grade/PrintReport";
import { ReportActions } from "@/components/grade/ReportActions";
import { RankBadge, TierBadge } from "@/components/ui/badges";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ACTIVE_STATES, JOB_ID } from "@/lib/grader/jobs.mjs";
import { CELEBRATIONS, celebrationLevel } from "@/lib/grader/present.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { faceOffPair, gradePage, type GradePage } from "@/lib/grade-page";
import { ROUTES } from "@/lib/nav";
import { SITE } from "@/lib/site";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";

// One grade: its progress while it runs, then the report (DECISIONS.md,
// "Grade my portfolio"). Reports are unlisted: the id is the only way in,
// the page says noindex (and next.config.ts sends X-Robots-Tag), and it is
// rendered per request, never cached for others.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

async function load(id: string): Promise<GradePage | null> {
  if (!graderEnabled() || !JOB_ID.test(id)) return null;
  return gradePage(id);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = await load((await params).id);
  const robots = { index: false, follow: false };
  if (!page) return { title: "Report not found - PortfolioRank", robots };
  const rep = page.job.report;
  const title = rep ? `${page.job.domain} - grade report - PortfolioRank` : `Grading ${page.job.domain} - PortfolioRank`;
  const description = rep
    ? `Tier ${rep.tier}${rep.percentile ? `, about top ${rep.percentile.topPct}% of ${rep.percentile.total.toLocaleString("en-US")} graded developer portfolios` : ""}. What a hiring manager sees, how it looks and reads, and what to fix first.`
    : "A PortfolioRank grade on its way.";
  return { title, description, robots, openGraph: { title, description, type: "article" }, twitter: { card: "summary_large_image", title, description } };
}

function LinkNote({ link }: { link?: string }) {
  if (link !== "used" && link !== "expired") return null;
  return (
    <p role="status" className="mb-5 flex items-start gap-2 rounded-xl border border-edge bg-raised p-3.5 text-sm print:hidden">
      <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
      {link === "used"
        ? "That email link was already used, so it didn't make this browser the report's owner. Anyone with the link can still read it."
        : "That email link expired, so it didn't make this browser the report's owner. Anyone with the link can still read it."}
    </p>
  );
}

/**
 * A grade whose screenshots and AI grade can't start ("unavailable": the
 * capture service isn't connected, as on staging): the free checks are the
 * whole answer, so the page shows them as the report does and says plainly
 * what is missing, instead of calling it a failure.
 */
function ChecksOnly({ page, link }: { page: GradePage; link?: string }) {
  const { job } = page;
  const steps = job.steps;
  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-5 px-4 py-10 sm:px-6 sm:py-14">
      <LinkNote link={link} />
      <section aria-labelledby="checks-only" className="card rise p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Free checks</p>
        <h1 id="checks-only" className="mt-1 break-words text-2xl font-bold tracking-tight">
          {page.name}
        </h1>
        <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-sm text-mute hover:text-accent">
          <span className="truncate">{job.domain}</span> <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <ol className="mt-5 grid grid-cols-1 gap-2 text-sm" aria-label="What ran">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-2.5">
              {s.state === "done" ? (
                <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />
              ) : (
                <CircleMinus className="h-4 w-4 shrink-0 text-mute" aria-hidden />
              )}
              <span className={s.state === "done" ? "" : "text-mute"}>{s.label}</span>
              <span className="sr-only">: {s.state === "done" ? "done" : "not available"}</span>
            </li>
          ))}
        </ol>
        <p role="status" className="mt-5 flex items-start gap-2 rounded-xl bg-raised p-3.5 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
          <span>
            Screenshots and the AI grade can&apos;t run right now (the capture service isn&apos;t connected), so there&apos;s no tier or rank. The free checks did run, and this is what they found.
          </span>
        </p>
      </section>

      <section aria-labelledby="hiring" className="card rise p-5 sm:p-6" style={d(80)}>
        <h2 id="hiring" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Briefcase className="h-4 w-4 text-mute" aria-hidden /> What a hiring manager sees
        </h2>
        <p className="mt-1 text-sm text-mute">Checked by code{job.checks && "measuredAt" in job.checks && typeof job.checks.measuredAt === "string" ? ` on ${day(job.checks.measuredAt)}` : ""}.</p>
        <div className="mt-4">
          <HiringView groups={page.checks!} whyHref={ROUTES.grading} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap print:hidden">
        <Link href="/grade" className={btnSecondary}>
          Grade another portfolio
        </Link>
        <Link href={ROUTES.top ?? "/"} className={btnSecondary}>
          See the leaderboard
        </Link>
      </div>
    </div>
  );
}

export default async function GradeReportPage({ params, searchParams }: Params & { searchParams: Promise<{ link?: string }> }) {
  const { id } = await params;
  const { link } = await searchParams;
  const page = await load(id);
  if (!page) notFound();
  const { job } = page;

  if (ACTIVE_STATES.includes(job.status)) {
    return (
      <>
        <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6 empty:hidden">
          <LinkNote link={link} />
        </div>
        <GradeProgress job={job} faceOff={ROUTES.faceoff ? await faceOffPair() : []} faceOffHref={ROUTES.faceoff} />
      </>
    );
  }

  if (job.status === "unavailable" && page.checks) return <ChecksOnly page={page} link={link} />;

  if (!job.report || !page.report) {
    const message =
      job.status === "unavailable"
        ? "Screenshots and the AI grade can't start right now, and the free checks didn't finish either. Try again in a little while."
        : (job.reason ?? (job.checks && !job.checks.ok ? job.checks.message : null) ?? "Something went wrong while grading. Try again.");
    return (
      <div className="mx-auto flex w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <section aria-labelledby="failed" className="card w-full p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Grade report</p>
          <h1 id="failed" className="mt-1 text-xl font-bold tracking-tight">
            We couldn&apos;t grade {job.domain}
          </h1>
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-raised p-3.5 text-sm">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden /> {message}
          </p>
          <div className="mt-5">
            <GradeForm compact initialUrl={job.url} />
          </div>
        </section>
      </div>
    );
  }

  const rep = job.report;
  const view = page.report;
  const pct = rep.percentile;
  const judgments = rep.judgments.filter((j) => typeof j.score === "number");
  const joinHref = `${SITE.submit}&url=${encodeURIComponent(job.url)}`;
  const claimHref = page.games && page.listed ? `/claim?url=${encodeURIComponent(page.listed.url)}` : null;
  const better = view.better;
  // The owner's result is celebrated (once per browser); a shared link isn't.
  const celebration = job.mine ? (CELEBRATIONS[celebrationLevel(rep)] ?? null) : null;

  const facts = view.groups.flatMap((g) => [...g.ok, ...g.missing]);
  const covered = view.groups.reduce((n, g) => n + g.ok.length, 0);
  const ranked = [...judgments].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0] ?? null;
  const weakest = ranked.length > 1 && (ranked[ranked.length - 1].score ?? 0) < (best?.score ?? 0) ? ranked[ranked.length - 1] : null;
  const first = view.fixes[0] ?? null;

  return (
    <>
      <div className="wrap report py-8 sm:py-10 print:hidden">
        <LinkNote link={link} />
        <Celebration id={job.id} level={celebration} anchor="report-tier" games={page.games} />

        {/* The summary: who, the result, the one thing to fix first */}
        <section aria-labelledby="overall" className="card card-featured rise overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <div className="flex min-w-0 flex-col p-5 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">
                Grade report <span className="text-mute">· {day(rep.gradedAt)}</span>
              </p>
              <h1 id="overall" className="mt-2 break-words text-3xl font-bold tracking-tight sm:text-4xl">
                {page.name}
              </h1>
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit max-w-full items-center gap-1 text-[15px] text-mute hover:text-accent">
                <span className="truncate">{job.domain}</span> <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>

              <div className="mt-7 flex items-center gap-5">
                <span id="report-tier" className="shrink-0">
                  <TierBadge tier={rep.tier} size="lg" />
                </span>
                <div className="min-w-0">
                  {pct ? (
                    <>
                      <p className="text-5xl font-bold leading-none tracking-tight sm:text-6xl">
                        Top {pct.topPct}
                        <span className="text-3xl sm:text-4xl">%</span>
                      </p>
                      <p className="mt-2 text-sm text-mute tabular-nums">
                        About #{pct.rank.toLocaleString("en-US")} of {pct.total.toLocaleString("en-US")} graded portfolios
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-5xl font-bold leading-none tracking-tight">Tier {rep.tier}</p>
                      <p className="mt-2 text-sm text-mute">Its place shows once more portfolios are graded.</p>
                    </>
                  )}
                </div>
              </div>
              <p className="mt-6 text-lg font-medium text-pretty">{view.verdict}</p>

              {first ? (
                <a href="#improve" className="group mt-5 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4 transition hover:border-accent/70">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fill text-on-fill">
                    <Wrench className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block text-[11px] font-bold uppercase tracking-wider text-accent">Fix this first</span>
                    <span className="mt-0.5 block text-[15px] font-semibold">{first.title}</span>
                    {first.effect && <span className="mt-0.5 block text-mute">Expected: {first.effect}</span>}
                  </span>
                  <ArrowRight className="nudge mt-1 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <span className="sr-only">See every fix</span>
                </a>
              ) : (
                <p className="mt-5 flex items-center gap-2.5 rounded-xl bg-raised p-4 text-sm">
                  <PartyPopper className="h-4 w-4 shrink-0 text-accent" aria-hidden /> Nothing urgent to fix: every check passes and every score is high.
                </p>
              )}

              <div className="mt-6">
                <ReportActions id={job.id} domain={job.domain} listed={!!page.listed} joinHref={joinHref} emailed={job.email.requested} games={page.games} />
              </div>
            </div>
            <div className="min-w-0 px-5 pb-5 sm:px-8 sm:pb-8 lg:py-8 lg:pl-0">
              <ScreenshotFrame src={page.hero} alt={`Screenshot of ${job.domain}`} domain={job.domain} eager className="w-full overflow-hidden rounded-xl border border-edge shadow-[var(--card-drop)]" />
            </div>
          </div>
        </section>

        {/* At a glance */}
        <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="At a glance">
          <Glance
            icon={<Briefcase className="h-4 w-4" aria-hidden />}
            label="Hiring basics"
            value={`${covered} of ${facts.length}`}
            note={covered === facts.length ? "All covered" : `${facts.length - covered} missing`}
            tone={covered === facts.length ? "up" : "accent"}
            href="#hiring"
          />
          {best && (
            <Glance icon={<Sparkles className="h-4 w-4" aria-hidden />} label="Strongest" value={`${best.score}/5`} note={best.label} tone="up" href="#ai" />
          )}
          {weakest ? (
            <Glance icon={<Target className="h-4 w-4" aria-hidden />} label="Most room to grow" value={`${weakest.score}/5`} note={weakest.label} tone="accent" href="#ai" />
          ) : (
            best && <Glance icon={<Target className="h-4 w-4" aria-hidden />} label="Most room to grow" value="None" note="Every score is the same" tone="up" href="#ai" />
          )}
        </ul>

        {/* What to do next */}
        {view.fixes.length > 0 && (
          <section aria-labelledby="improve" className="card reveal mt-5 scroll-mt-24 p-5 sm:p-6">
            <SectionHead id="improve" icon={<Wrench className="h-4 w-4" aria-hidden />} title="Fix these first" note="In order of what each one should change." />
            <ol className="mt-4 grid grid-cols-1 gap-3">
              {view.fixes.map((m, i) => (
                <li key={m.criterion} className={`flex gap-3.5 rounded-xl p-4 ${i === 0 ? "border border-accent/40 bg-accent-soft" : "border border-edge bg-raised/60"}`}>
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold ${i === 0 ? "bg-fill text-on-fill" : "bg-card text-ink ring-1 ring-edge-strong"}`}>{i + 1}</span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold text-[15px]">{m.title}</span>
                      <span className="rounded-full border border-edge-strong px-1.5 py-0.5 text-[11px] font-medium text-mute">{m.by === "code" ? "Measured" : "Gemini"}</span>
                    </span>
                    <span className="mt-0.5 block text-mute">{m.why}</span>
                    {m.effect && (
                      <span className="mt-1.5 flex items-center gap-1.5">
                        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-up" aria-hidden />
                        <span>
                          <span className="text-mute">Expected:</span> {m.effect}
                        </span>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* What a hiring manager sees, and how it looks and reads */}
        <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
          <section aria-labelledby="hiring" className="card reveal scroll-mt-24 p-5 sm:p-6">
            <SectionHead id="hiring" icon={<Briefcase className="h-4 w-4" aria-hidden />} title="What a hiring manager sees" note={`Checked by code on ${day(rep.gradedAt)}.`} />
            <div className="mt-4">
              <HiringView groups={view.groups} whyHref={ROUTES.grading} />
            </div>
          </section>
          <section aria-labelledby="ai" className="card reveal scroll-mt-24 p-5 sm:p-6" style={d(80)}>
            <SectionHead
              id="ai"
              icon={<Bot className="h-4 w-4" aria-hidden />}
              title="How it looks and reads"
              note="Gemini, from one screenshot and the page text, 1 to 5."
              aside={
                <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute" title={rep.model ?? undefined}>
                  Gemini
                </span>
              }
            />
            <ul className="mt-3 divide-y divide-edge">
              {judgments.map((s) => (
                <li key={s.id} className="py-3.5">
                  <div className="flex items-center gap-3">
                    {ROUTES.grading ? (
                      <a href={ROUTES.grading} className="min-w-0 flex-1 text-sm font-semibold hover:text-accent">
                        {s.label}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 text-sm font-semibold">{s.label}</span>
                    )}
                    <span className="flex gap-1" aria-hidden>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <span key={i} className={`h-1.5 w-5 rounded-full ${i <= (s.score ?? 0) ? ((s.score ?? 0) >= 4 ? "bg-up" : "bg-fill") : "bg-edge"}`} />
                      ))}
                    </span>
                    <span className="w-8 text-right text-sm font-semibold tabular-nums">
                      {s.score}
                      <span className="text-mute">/5</span>
                    </span>
                  </div>
                  {s.note && <p className="mt-1 text-sm text-mute">{s.note}</p>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Learn from one that does it better */}
        {better && (
          <section aria-labelledby="better" className="card reveal mt-5 overflow-hidden">
            <div className="p-5 pb-0 sm:p-6 sm:pb-0">
              <SectionHead id="better" icon={<TrendingUp className="h-4 w-4" aria-hidden />} title="Portfolios doing it better" note="Ranked above this one, with the thing it does better." />
            </div>
            <div className="mt-4 grid grid-cols-1 border-t border-edge md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <a href={better.site.path} className="group block overflow-hidden border-edge max-md:border-b md:border-r" tabIndex={-1} aria-hidden>
                <ScreenshotFrame src={better.site.hero} alt="" domain={better.site.domain} className="h-full w-full transition duration-500 group-hover:scale-[1.02]" />
              </a>
              <div className="flex flex-col justify-center p-5 sm:p-7">
                <p className="flex items-center gap-2.5">
                  {better.site.rank && <RankBadge rank={better.site.rank} />}
                  <span className="min-w-0">
                    <span className="block truncate text-lg font-semibold">{better.site.name}</span>
                    {better.site.rank && (
                      <span className="block text-xs text-mute tabular-nums">
                        #{better.site.rank} on the AI grade · Top {better.site.topPct}%
                      </span>
                    )}
                  </span>
                </p>
                <p className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Better {better.label.toLowerCase()}: {better.theirs} vs {better.yours}
                </p>
                {better.note && <p className="mt-2 text-[15px] text-mute">{better.note}</p>}
                <div className="mt-5 flex flex-wrap gap-2">
                  <a href={better.site.path} className={`${btnSecondary} h-10 px-3.5`}>
                    See its report
                  </a>
                  <a href={better.site.url} target="_blank" rel="noopener noreferrer" className={`${btnSecondary} h-10 px-3.5`}>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Visit<span className="sr-only"> {better.site.domain} (opens in a new tab)</span>
                  </a>
                  {ROUTES.faceoff && (
                    <a href={ROUTES.faceoff} className={`${btnPrimary} h-10 px-3.5`}>
                      Compare in a face-off <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
                    </a>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {view.similar.length > 0 && (
          <section aria-labelledby="similar" className="reveal mt-10">
            <SectionHead id="similar" icon={<Users className="h-4 w-4" aria-hidden />} title="Similar portfolios" note="Graded close to this one: good company to compare with." />
            <ul className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {view.similar.map((r) => (
                <li key={r.url}>
                  <a href={r.path} className="card card-hover group block overflow-hidden">
                    <ScreenshotFrame src={r.hero} alt="" domain={r.domain} className="w-full border-b border-edge" />
                    <span className="flex items-center gap-2 p-3">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{r.name}</span>
                        <span className="block truncate text-xs text-mute tabular-nums">{r.rank ? `#${r.rank} · Top ${r.topPct}%` : r.domain}</span>
                      </span>
                      <TierBadge tier={r.tier} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(job.mine || claimHref) && (
          <OwnerPanel
            id={job.id}
            url={job.url}
            domain={job.domain}
            mine={job.mine}
            claimHref={claimHref}
            gradedAt={rep.gradedAt}
            regradeAfter={rep.regradeAfter}
            cooldownDays={REGRADE_COOLDOWN_DAYS}
            now={page.at}
            afterDelete={ROUTES.grade ? `${ROUTES.grade}?deleted=1` : "/"}
          />
        )}

        {ROUTES.play && (
          <p className="mt-10 text-center">
            <a href={ROUTES.play} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
              Think you can spot a top 10% portfolio? Play a round <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          </p>
        )}
      </div>

      <PrintReport
        id={job.id}
        name={page.name}
        url={job.url}
        domain={job.domain}
        hero={page.hero}
        tier={rep.tier}
        percentile={pct}
        verdict={view.verdict}
        gradedAt={day(rep.gradedAt)}
        model={rep.model}
        groups={view.groups}
        judgments={judgments.map((j) => ({ id: j.id, label: j.label, score: j.score ?? 0, note: j.note ?? "" }))}
        fixes={view.fixes}
        better={better ? { name: better.site.name, domain: better.site.domain, label: better.label, theirs: better.theirs, yours: better.yours, note: better.note } : null}
        similar={view.similar.map((s) => ({ name: s.name, domain: s.domain, tier: s.tier, topPct: s.topPct }))}
        covered={covered}
        factCount={facts.length}
      />
    </>
  );
}

/** One "at a glance" tile: a label, a big value and what it is about. */
function Glance({ icon, label, value, note, tone, href }: { icon: React.ReactNode; label: string; value: string; note: string; tone: "up" | "accent"; href: string }) {
  return (
    <li>
      <a href={href} className="card card-hover reveal flex h-full items-center gap-3.5 p-4">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone === "up" ? "bg-up/10 text-up" : "bg-accent-soft text-accent"}`}>{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold uppercase tracking-wider text-mute">{label}</span>
          <span className="mt-0.5 flex items-baseline gap-2">
            <span className="text-xl font-bold tabular-nums">{value}</span>
            <span className="truncate text-sm text-mute">{note}</span>
          </span>
        </span>
      </a>
    </li>
  );
}

/** A section's heading: an icon tile, the title, one line under it and an optional mark on the right. */
function SectionHead({ id, icon, title, note, aside }: { id: string; icon: React.ReactNode; title: string; note?: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="icon-tile h-9 w-9 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-lg font-bold leading-tight tracking-tight">
          {title}
        </h2>
        {note && <p className="mt-0.5 text-sm text-mute">{note}</p>}
      </div>
      {aside}
    </div>
  );
}
