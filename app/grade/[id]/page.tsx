import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bot, Briefcase, CircleAlert, CircleCheck, CircleMinus, ExternalLink, Link2Off, PartyPopper, Rocket, Sparkles, TrendingUp, Wrench } from "lucide-react";
import { Celebration } from "@/components/grade/Celebration";
import { GradeForm } from "@/components/grade/GradeForm";
import { GradeProgress } from "@/components/grade/GradeProgress";
import { HiringView } from "@/components/grade/HiringView";
import { OwnerPanel } from "@/components/grade/OwnerPanel";
import { ReportActions } from "@/components/grade/ReportActions";
import { LetterBadge, RankBadge } from "@/components/ui/badges";
import { tierLabel } from "@/lib/tiers.mjs";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ACTIVE_STATES, JOB_ID } from "@/lib/grader/jobs.mjs";
import { CELEBRATIONS, celebrationLevel } from "@/lib/grader/present.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { faceOffPair, gradePage, type GradePage } from "@/lib/grade-page";
import { ROUTES } from "@/lib/nav";
import { SITE, SITE_HOST } from "@/lib/site";
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
    ? `${rep.eloTiers ? (rep.tier ? `Tier ${tierLabel(rep.tier)}, graded` : "Graded") : `Tier ${rep.tier}`}${rep.percentile ? `, about top ${rep.percentile.topPct}% of ${rep.percentile.total.toLocaleString("en-US")} graded developer portfolios` : ""}. What a hiring manager sees, how it looks and reads, and what to fix first.`
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

  return (
    <div className="wrap report py-8 sm:py-10">
      <LinkNote link={link} />
      <Celebration id={job.id} level={celebration} anchor="report-tier" games={page.games} />

      {/* The result first */}
      <section aria-labelledby="overall" className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="card card-featured rise overflow-hidden">
          <ScreenshotFrame src={page.hero} alt={`Screenshot of ${job.domain}`} domain={job.domain} eager className="w-full lg:aspect-auto lg:h-full" />
        </div>
        <div className="card rise flex flex-col p-6 sm:p-8" style={d(80)}>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Grade report</p>
          <h1 id="overall" className="mt-2 break-words text-2xl font-bold tracking-tight sm:text-3xl">
            {page.name}
          </h1>
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-sm text-mute hover:text-accent">
            <span className="truncate">{job.domain}</span> <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>

          <div className="mt-6 flex items-center gap-5">
            <span id="report-tier" className="shrink-0">
              <LetterBadge tier={rep.tier} elo={rep.eloTiers} size="lg" />
            </span>
            <div className="min-w-0">
              {pct ? (
                <>
                  <p className="text-5xl font-bold leading-none tracking-tight sm:text-6xl">
                    Top {pct.topPct}
                    <span className="text-3xl sm:text-4xl">%</span>
                  </p>
                  <p className="mt-1.5 text-sm text-mute">
                    of {pct.total.toLocaleString("en-US")} graded portfolios · about #{pct.rank.toLocaleString("en-US")}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-4xl font-bold leading-none tracking-tight sm:text-5xl">
                    {rep.eloTiers ? (rep.tier ? `Tier ${tierLabel(rep.tier)}` : "Graded") : <>Tier {rep.tier}</>}
                  </p>
                  <p className="mt-1.5 text-sm text-mute">Its place among other portfolios shows once more are graded.</p>
                </>
              )}
            </div>
          </div>
          <p className="mt-5 text-lg font-medium text-pretty">{view.verdict}</p>
          <p className="mt-1 text-xs text-mute">Graded {day(rep.gradedAt)}. A grade describes the page, not the developer.</p>

          <div className="mt-auto pt-6">
            <ReportActions id={job.id} domain={job.domain} listed={!!page.listed} joinHref={joinHref} emailed={job.email.requested} games={page.games} />
          </div>
        </div>
      </section>

      {/* What a hiring manager sees, and how it looks and reads */}
      <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-labelledby="hiring" className="card reveal p-5 sm:p-6">
          <h2 id="hiring" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <Briefcase className="h-4 w-4 text-mute" aria-hidden /> What a hiring manager sees
          </h2>
          <p className="mt-1 text-sm text-mute">Checked by code on {day(rep.gradedAt)}.</p>
          <div className="mt-4">
            <HiringView groups={view.groups} whyHref={ROUTES.grading} />
          </div>
        </section>
        <section aria-labelledby="ai" className="card reveal p-5 sm:p-6" style={d(80)}>
          <h2 id="ai" className="flex items-center justify-between gap-2 text-lg font-bold tracking-tight">
            <span className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-mute" aria-hidden /> How it looks and reads
            </span>
            <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute" title={rep.model ?? undefined}>
              Gemini
            </span>
          </h2>
          <p className="mt-1 text-sm text-mute">Judged from one screenshot and the page text, 1 to 5.</p>
          <ul className="mt-4 divide-y divide-edge">
            {judgments.map((s) => (
              <li key={s.id} className="py-3">
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
                      <span key={i} className={`h-1.5 w-5 rounded-full ${i <= (s.score ?? 0) ? "bg-fill" : "bg-edge"}`} />
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

      {/* What to do next */}
      <section aria-labelledby="improve" className="card reveal mt-5 p-5 sm:p-6">
        {view.fixes.length > 0 ? (
          <>
            <h2 id="improve" className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <Wrench className="h-4 w-4 text-mute" aria-hidden /> Fix these first
            </h2>
            <ol className={`mt-4 grid grid-cols-1 gap-3 ${view.fixes.length >= 3 ? "md:grid-cols-3" : view.fixes.length === 2 ? "md:grid-cols-2" : ""}`}>
              {view.fixes.map((m, i) => (
                <li key={m.criterion} className={`flex gap-3 rounded-xl p-4 ${i === 0 ? "border border-accent/40 bg-accent-soft" : "bg-raised"}`}>
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fill text-sm font-bold text-on-fill">{i + 1}</span>
                  <span className="min-w-0 text-sm">
                    {i === 0 && <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-accent">Biggest win</span>}
                    <span className="block font-semibold">{m.title}</span>
                    <span className="mt-0.5 block text-mute">{m.why}</span>
                    {m.effect && (
                      <span className="mt-1.5 block">
                        <span className="text-mute">Expected:</span> {m.effect}
                      </span>
                    )}
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
                <li>Get it into more face-offs: people&apos;s votes are what move the rank now.</li>
                <li>Re-grade after each big change, so the report keeps up.</li>
              </ul>
            </div>
            {ROUTES.faceoff && (
              <a href={ROUTES.faceoff} className={`${btnPrimary} shrink-0 print:hidden`}>
                <Rocket className="h-4 w-4" aria-hidden /> Play a face-off
              </a>
            )}
          </div>
        )}
      </section>

      {/* Learn from one that does it better */}
      {better && (
        <section aria-labelledby="better" className="reveal mt-12">
          <h2 id="better" className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <TrendingUp className="h-5 w-5 text-accent" aria-hidden /> Portfolios doing it better
          </h2>
          <p className="mt-1 text-sm text-mute">Ranked above this one, with the thing it does better.</p>
          <div className="card mt-5 grid grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
              <div className="mt-5 flex flex-wrap gap-2 print:hidden">
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
        <section aria-labelledby="similar" className="reveal mt-12">
          <h2 id="similar" className="text-2xl font-bold tracking-tight">
            Similar portfolios
          </h2>
          <p className="mt-1 text-sm text-mute">Graded close to this one: good company to compare with.</p>
          <ul className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {view.similar.map((r) => (
              <li key={r.url}>
                <a href={r.path} className="card card-hover group block overflow-hidden">
                  <ScreenshotFrame src={r.hero} alt="" domain={r.domain} className="w-full border-b border-edge" />
                  <span className="flex items-center gap-2 p-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.name}</span>
                      <span className="block truncate text-xs text-mute tabular-nums">{r.rank ? `#${r.rank} · Top ${r.topPct}%` : r.domain}</span>
                    </span>
                    <LetterBadge tier={r.tier} elo={rep.eloTiers} />
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

      <p className="mt-6 hidden text-xs text-mute print:block">
        Graded by Gemini{rep.model ? ` (${rep.model})` : ""} on {day(rep.gradedAt)}: an opinion about the page, not a verdict on the developer. {SITE_HOST}
      </p>

      {ROUTES.play && (
        <p className="mt-10 text-center print:hidden">
          <a href={ROUTES.play} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
            Think you can spot a top 10% portfolio? Play a round <ArrowRight className="nudge h-4 w-4" aria-hidden />
          </a>
        </p>
      )}
    </div>
  );
}
