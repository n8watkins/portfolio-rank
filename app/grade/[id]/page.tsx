import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Briefcase, CircleAlert, CircleCheck, CircleMinus, ExternalLink, Link2Off } from "lucide-react";
import { GradeForm } from "@/components/grade/GradeForm";
import { GradeProgress } from "@/components/grade/GradeProgress";
import { Report } from "@/components/grade/Report";
import { HiringView } from "@/components/grade/HiringView";
import { btnSecondary } from "@/components/ui/styles";
import { ACTIVE_STATES, JOB_ID } from "@/lib/grader/jobs.mjs";
import { CELEBRATIONS, celebrationLevel } from "@/lib/grader/present.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { faceOffPair, gradePage, type GradePage } from "@/lib/grade-page";
import { ROUTES } from "@/lib/nav";

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

  // The owner's result is celebrated (once per browser); a shared link isn't.
  const celebration = job.mine ? (CELEBRATIONS[celebrationLevel(job.report)] ?? null) : null;
  return <Report page={page} link={<LinkNote link={link} />} celebration={celebration} now={page.at} />;
}
