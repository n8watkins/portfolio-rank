import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CircleCheck, Link2Off, ListChecks, Sparkles, Trophy } from "lucide-react";
import { GradeForm } from "@/components/grade/GradeForm";
import { graderEnabled } from "@/lib/grader/server";
import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";

// "Grade yours" (ROUTES.grade): paste a link, get a report. The report and
// its progress live at /grade/<id>; this page also answers the one-time
// email link's "bad link" and a deleted report.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Grade your portfolio - PortfolioRank",
  description: "Paste your developer portfolio's link: a grade, where you'd rank and the three things to fix first. Free, no account needed.",
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const WHAT = [
  { Icon: Trophy, title: "Your grade and rank", body: `A tier from SSS to D, set by your place among ${PORTFOLIO_COUNT_LABEL} developer portfolios.` },
  { Icon: ListChecks, title: "What a hiring manager sees", body: "Contact, resume, GitHub, working links and your own domain, checked by code." },
  { Icon: Sparkles, title: "The three things to fix first", body: "With what each one should change, and portfolios that do it better." },
];

export default async function GradeStart({ searchParams }: { searchParams: Promise<{ url?: string; link?: string; deleted?: string }> }) {
  if (!graderEnabled()) notFound();
  const sp = await searchParams;
  const initialUrl = typeof sp.url === "string" ? sp.url.slice(0, 500) : "";
  return (
    <div className="band band-glow">
      <section aria-labelledby="grade-start" className="mx-auto max-w-2xl px-4 py-14 text-center sm:px-6 sm:py-20">
        {sp.link === "bad" && (
          <p role="status" className="mb-6 flex items-start gap-2 rounded-xl border border-edge bg-card p-3.5 text-left text-sm">
            <Link2Off className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden /> That email link isn&apos;t valid. Grade your portfolio again, or open the newest email we sent.
          </p>
        )}
        {sp.deleted === "1" && (
          <p role="status" className="mb-6 flex items-start gap-2 rounded-xl border border-edge bg-card p-3.5 text-left text-sm">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden /> The report and its screenshots are deleted. Its link no longer works.
          </p>
        )}
        <h1 id="grade-start" className="rise text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          How good is your <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">portfolio</span>?
        </h1>
        <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(60)}>
          Paste a link. In about a minute you get a grade, where you&apos;d rank and the three things to fix first. Free, no account needed.
        </p>
        <div id="grade" className="rise mt-8 text-left" style={d(120)}>
          <GradeForm initialUrl={initialUrl} />
        </div>
      </section>
      <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {WHAT.map(({ Icon, title, body }, i) => (
            <li key={title} className="card rise p-5" style={d(180 + 60 * i)}>
              <span className="icon-tile h-10 w-10">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <p className="mt-3 font-semibold">{title}</p>
              <p className="mt-1 text-sm text-mute">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
