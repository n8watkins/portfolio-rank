import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListChecks, Sparkles, Trophy } from "lucide-react";
import { toolsEnabled } from "@/lib/tools/server";
import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";
import { AddForm } from "@/components/add/AddForm";

// "Add your portfolio" (ROUTES.add, owner 2026-11-12): the one way in. Every
// check runs at once and the portfolio gets its profile, where its rank, AI
// report card and fix list live (app/p/[slug], docs/TOOLS.md).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add Your Portfolio: Free Speed, Link Preview and Hiring Checks - PortfolioRank",
  description:
    "Add your developer portfolio to PortfolioRank for free: Lighthouse on mobile and desktop, your link preview, resume, GitHub, contact and project-link checks, an AI report card and a rank.",
  alternates: { canonical: "/add" },
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const WHAT = [
  { Icon: ListChecks, title: "A fix list, right away", body: "Speed on phones and desktops, how your link looks when shared, and the basics hiring managers look for, each with how to fix it." },
  { Icon: Sparkles, title: "An AI report card", body: "Design, writing and projects scored with notes, weakest first. It fills in when your portfolio is graded." },
  { Icon: Trophy, title: "A rank", body: `Face-offs against ${PORTFOLIO_COUNT_LABEL} developer portfolios set your letter, from S to D.` },
];

export default async function AddPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  if (!toolsEnabled()) notFound();
  const sp = await searchParams;
  const initialUrl = typeof sp.url === "string" ? sp.url.slice(0, 500) : "";
  return (
    <div className="band band-glow">
      <section aria-labelledby="add-title" className="mx-auto max-w-2xl px-4 py-14 text-center sm:px-6 sm:py-20">
        <h1 id="add-title" className="rise text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Add your <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">portfolio</span>
        </h1>
        <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(60)}>
          Paste your link. Every check runs at once, and your portfolio gets its own page with what to fix. Free, no account.
        </p>
        <div className="rise mt-8" style={d(120)}>
          <AddForm initialUrl={initialUrl} />
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
