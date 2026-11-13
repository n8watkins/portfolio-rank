import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRight, Gauge, ListChecks, Share2, Sparkles } from "lucide-react";
import { TOOLS, liveTools, type ToolId } from "@/lib/tools/catalog";
import { toolsEnabled } from "@/lib/tools/server";
import { ROUTES } from "@/lib/nav";
import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { btnPrimary } from "@/components/ui/styles";
import { Glow, ToolsHero } from "@/components/tools/ToolsHero";

// The free tools' hub (docs/TOOLS.md): "Check my portfolio" runs every live
// tool on one address in one go; each tool also has its own page for search.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Free Portfolio Checker: Speed, Share Preview and Checklist - PortfolioRank",
  description:
    "Check your developer portfolio for free: Lighthouse speed on mobile and desktop, how your link looks when shared, and a hiring checklist, with plain fixes for each.",
  alternates: { canonical: "/tools" },
};

const ICONS: Record<ToolId, typeof Gauge> = { speed: Gauge, share: Share2, checklist: ListChecks };

export default async function ToolsHub({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  if (!toolsEnabled()) notFound();
  const sp = await searchParams;
  const initialUrl = typeof sp.url === "string" ? sp.url.slice(0, 500) : "";
  return (
    <>
      <ToolsHero
        kicker="Free tools"
        title={
          <>
            Check your <Glow>portfolio</Glow>
          </>
        }
        lead="One link, every free check: speed on phones and desktops, how it looks when shared, and what hiring managers look for. With a plain fix for each."
        tools={liveTools().map((t) => t.id)}
        initialUrl={initialUrl}
      />

      <section aria-labelledby="tools-list" className="wrap max-w-6xl pb-6 pt-10">
        <SectionHeader eyebrow="Or one at a time" title="The tools" id="tools-list" />
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TOOLS.map((t) => {
            const Icon = ICONS[t.id];
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <span className="icon-tile h-10 w-10">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  {!t.live && <span className="rounded-full bg-raised px-2.5 py-1 text-xs font-medium text-mute">Coming soon</span>}
                </div>
                <h3 className="mt-4 font-semibold">{t.name}</h3>
                <p className="mt-1.5 text-sm text-mute">{t.blurb}</p>
                {t.live && (
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                    Open <ArrowRight className="nudge h-4 w-4" aria-hidden />
                  </span>
                )}
              </>
            );
            return (
              <li key={t.id} className="flex">
                {t.live ? (
                  <a href={t.href} className="card card-hover group flex w-full flex-col p-5">
                    {body}
                  </a>
                ) : (
                  <div className="card flex w-full flex-col p-5 opacity-80">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {ROUTES.grade && (
        <section aria-labelledby="tools-grade" className="wrap max-w-6xl pt-10">
          <div className="card card-featured flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div className="max-w-2xl">
              <h2 id="tools-grade" className="text-xl font-bold tracking-tight sm:text-2xl">
                Want the full picture?
              </h2>
              <p className="mt-2 text-sm text-mute sm:text-base">
                The free checks measure the basics. A grade reads your portfolio like a hiring manager: a tier from S to D, where you&apos;d rank among{" "}
                {PORTFOLIO_COUNT_LABEL} developer portfolios, and the three things to fix first.
              </p>
            </div>
            <a href={ROUTES.grade} className={`${btnPrimary} shrink-0`}>
              <Sparkles className="h-4 w-4" aria-hidden /> Grade my portfolio
            </a>
          </div>
        </section>
      )}
    </>
  );
}
