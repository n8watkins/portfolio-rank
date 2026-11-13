import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bot, Briefcase, CircleAlert, CircleCheck, CircleMinus, ExternalLink, Link2Off, Swords, Wrench } from "lucide-react";
import { Celebration } from "@/components/grade/Celebration";
import { GradeForm } from "@/components/grade/GradeForm";
import { GradeProgress } from "@/components/grade/GradeProgress";
import { HiringView } from "@/components/grade/HiringView";
import { OwnerPanel } from "@/components/grade/OwnerPanel";
import { ReportActions } from "@/components/grade/ReportActions";
import { LetterBadge } from "@/components/ui/badges";
import { WholePage } from "@/components/grade/WholePage";
import { MIN_FACEOFFS, tierLabel } from "@/lib/tiers.mjs";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnSecondary } from "@/components/ui/styles";
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
  // With tiers by ELO the letter and the grade's own standing are told apart: "Tier B. The grade: about top 7% of 60 ...".
  const description = rep
    ? rep.eloTiers
      ? `${rep.tier ? `Tier ${tierLabel(rep.tier)}. ` : ""}${rep.percentile ? `The grade: about top ${rep.percentile.topPct}% of ${rep.percentile.total.toLocaleString("en-US")} graded developer portfolios. ` : ""}What a hiring manager sees, how it looks and reads, and what to fix first.`
      : `Tier ${rep.tier}${rep.percentile ? `, about top ${rep.percentile.topPct}% of ${rep.percentile.total.toLocaleString("en-US")} graded developer portfolios` : ""}. What a hiring manager sees, how it looks and reads, and what to fix first.`
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
  // The owner's result is celebrated (once per browser); a shared link isn't.
  const celebration = job.mine ? (CELEBRATIONS[celebrationLevel(rep)] ?? null) : null;
  const st = page.standing;

  return (
    <div className="wrap report py-8 sm:py-10">
      <LinkNote link={link} />
      <Celebration id={job.id} level={celebration} anchor="report-tier" games={page.games} />

      {/* The header: small desktop and phone shots with the title on the left, the result at the top right. */}
      <section aria-labelledby="overall" className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-y-5">
        <div className="rise min-w-0 lg:col-start-1 lg:row-start-1">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Grade report</p>
          <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-start">
            <a href={job.url} target="_blank" rel="noopener noreferrer" className="flex shrink-0 items-end gap-2.5" tabIndex={-1} aria-hidden>
              <ScreenshotFrame src={page.hero} alt="" domain={job.domain} eager className="w-44 rounded-lg border border-edge shadow-sm" />
              <ScreenshotFrame src={page.mobile} alt="" domain={job.domain} kind="mobile" eager className="w-[3.2rem] rounded-md border border-edge shadow-sm" />
            </a>
            <div className="min-w-0">
              <h1 id="overall" className="break-words text-2xl font-bold tracking-tight sm:text-3xl">
                {page.name}
              </h1>
              <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex w-fit max-w-full items-center gap-1 text-sm text-mute hover:text-accent">
                <span className="truncate">{job.domain}</span> <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              <p className="mt-3 text-lg font-medium text-pretty">{view.verdict}</p>
              <p className="mt-1 text-xs text-mute">Graded {day(rep.gradedAt)}. A grade describes the page, not the developer.</p>
            </div>
          </div>
        </div>

        {/* The result, front and center: one answer that never disagrees with itself. */}
        <aside aria-label="Result" className="card rise p-5 sm:p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1" style={d(80)}>
          {st.settled ? (
            <div className="flex items-center gap-4">
              <span id="report-tier" className="shrink-0">
                <LetterBadge tier={st.tier} elo size="lg" />
              </span>
              <div className="min-w-0">
                <p className="text-4xl font-bold leading-none tracking-tight">
                  Top {st.topPct}
                  <span className="text-2xl">%</span>
                </p>
                <p className="mt-1.5 text-sm text-mute">
                  Tier {tierLabel(st.tier)}, from {st.faceoffs.toLocaleString("en-US")} face-offs
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4">
                <span id="report-tier" className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border-2 border-dashed border-edge-strong text-mute" role="img" aria-label="Provisional: no tier yet">
                  <Swords className="h-6 w-6" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-2xl font-bold leading-tight tracking-tight">Provisional</p>
                  <p className="mt-0.5 text-sm text-mute">
                    A tier comes after {MIN_FACEOFFS} face-offs <span className="whitespace-nowrap">· {Math.min(st.faceoffs, MIN_FACEOFFS)} so far</span>
                  </p>
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-edge" aria-hidden>
                <span className="block h-full rounded-full bg-fill" style={{ width: `${(100 * Math.min(st.faceoffs, MIN_FACEOFFS)) / MIN_FACEOFFS}%` }} />
              </div>
              {pct && (
                <p className="mt-4 border-t border-edge pt-3 text-sm">
                  <span className="text-mute">The AI grade alone:</span> <strong className="tabular-nums">top {pct.topPct}%</strong>{" "}
                  <span className="text-mute">of {pct.total.toLocaleString("en-US")} graded portfolios</span>
                </p>
              )}
            </>
          )}
          {ROUTES.grading && (
            <a href={`${ROUTES.grading}#tiers`} className="mt-3 inline-block text-xs font-semibold text-accent hover:underline print:hidden">
              How tiers work
            </a>
          )}
        </aside>
        {/* On a phone the result comes right under the title, before the actions. */}
        <div className="rise min-w-0 lg:col-start-1 lg:row-start-2">
          <ReportActions id={job.id} domain={job.domain} listed={!!page.listed} joinHref={joinHref} emailed={job.email.requested} games={page.games} />
        </div>
      </section>

      {/* Fix these, by effect: only when there is something to fix. */}
      {view.fixes.length > 0 && (
        <section aria-labelledby="improve" className="reveal mt-12">
          <h2 id="improve" className="flex items-center gap-2 border-b border-edge pb-2 text-lg font-bold tracking-tight">
            <Wrench className="h-4 w-4 text-mute" aria-hidden /> Fix these, in order
            <span className="ml-auto text-xs font-medium text-mute">Most effect first</span>
          </h2>
          <ol className="divide-y divide-edge">
            {view.fixes.map((m, i) => (
              <li key={m.criterion} className="flex gap-3 py-3.5">
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold ${i === 0 ? "bg-fill text-on-fill" : "bg-raised ring-1 ring-edge-strong"}`}>{i + 1}</span>
                <span className="min-w-0 text-sm">
                  <span className="block font-semibold">{m.title}</span>
                  <span className="mt-0.5 block text-mute">{m.why}</span>
                  {m.effect && (
                    <span className="mt-1 block">
                      <span className="text-mute">Expected:</span> {m.effect}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* What a hiring manager sees, and how it looks and reads: as the live report has them, as page sections. */}
      <div className="mt-12 grid grid-cols-1 items-start gap-x-12 gap-y-12 lg:grid-cols-2">
        <section aria-labelledby="hiring" className="reveal">
          <h2 id="hiring" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <Briefcase className="h-4 w-4 text-mute" aria-hidden /> What a hiring manager sees
          </h2>
          <p className="mt-1 text-sm text-mute">Checked by code on {day(rep.gradedAt)}.</p>
          <div className="mt-4">
            <HiringView groups={view.groups} whyHref={ROUTES.grading} />
          </div>
        </section>
        <section aria-labelledby="ai" className="reveal" style={d(80)}>
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

      {/* MOCK: the whole page, scrolling in a laptop and a phone. */}
      {job.shots && <WholePage desktop={`/api/grade/${job.id}/shot/full.jpg`} phone={`/api/grade/${job.id}/shot/mobile-full.jpg`} domain={job.domain} />}

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
