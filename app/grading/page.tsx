import type { Metadata } from "next";
import { ArrowRight, Bot, ChevronRight, CircleCheck, Code2, Swords, Trophy } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { CHECK_ITEMS, CHECK_POINTS } from "@/lib/check-points.mjs";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ROUTES } from "@/lib/nav";
import { AI_CRITERIA, CODE_CRITERIA } from "@/pipeline/rubric.mjs";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";
import { rankingViewsEnabled } from "@/lib/leaderboard";
import { EloGrading } from "@/components/tiers/EloGrading";

// How grading works, kept short: the Code checks score that sets where a
// portfolio starts (owner, 2026-11-22: never the AI), what "top X%" means,
// what is checked and how votes combine. The points come from
// lib/check-points.mjs and the criteria from the rubric (pipeline/rubric.mjs),
// so this page follows them when they change. Tier letters stay on the
// RANKING_V2 page (components/tiers/EloGrading.tsx).

export const metadata: Metadata = {
  title: "How grading works - PortfolioRank",
  description: "What code measures for the Code checks score, what a top 10% place says, what Gemini's report card is and how people's votes move the ranking.",
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

/** The bands a report names, best first: `of` is the band's share in twentieths, drawn as a little bar. */
const BANDS = [
  { band: "Top 5%", of: 1, note: "1 in 20" },
  { band: "Top 10%", of: 2, note: "1 in 10" },
  { band: "Top 25%", of: 5, note: "1 in 4" },
  { band: "Top half", of: 10, note: "1 in 2" },
];

// The facts that count, in short words.
const FACT_NAMES: Record<string, string> = {
  contact: "Contact",
  resume: "Resume",
  github: "GitHub",
  project_links: "Working project links",
  own_domain: "Own domain",
  fresh_footer: "Up-to-date footer",
  original: "Not a template",
};

const pct = (w: number) => `${Math.round(w * 100)}%`;

export default function GradingPage() {
  // Tiers by ELO (RANKING_V2): the explanation of letters from votes and starting ranks from checks.
  if (rankingViewsEnabled()) return <EloGrading />;
  const facts = CODE_CRITERIA.filter((c) => c.weight > 0);
  return (
    <div className="pb-20">
      <section aria-labelledby="grading" className="band band-glow">
        <div className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
          <p className="rise text-xs font-semibold uppercase tracking-[0.14em] text-accent">Grading</p>
          <h1 id="grading" className="rise mt-2 text-4xl font-bold tracking-tight text-balance sm:text-5xl" style={d(40)}>
            How grading works
          </h1>
          <p className="rise mx-auto mt-4 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(80)}>
            Code measures the site and sets where it starts. Gemini writes a report card on the side. People&apos;s votes decide the leaderboard.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        {/* The Code checks score */}
        <section aria-labelledby="score" className="mt-12">
          <SectionHeader id="score" eyebrow="The score" title="The Code checks score, out of 100" className="mb-5" />
          <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {CHECK_ITEMS.map((i) => (
              <li key={i.id} className="flex items-baseline justify-between gap-3 border-b border-edge py-2 text-sm">
                <span>{i.name}</span>
                <span className="shrink-0 tabular-nums text-mute">{CHECK_POINTS[i.id as keyof typeof CHECK_POINTS]} pts</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-mute">
            Code measures each one from the page, Lighthouse and the share card, with no AI. Something not measured yet counts the library&apos;s
            median, never zero. Where a portfolio starts in the ranking comes from this score, not from the AI.
          </p>
        </section>

        {/* Top X% */}
        <section aria-labelledby="place" className="mt-14">
          <SectionHeader id="place" eyebrow="Your place" title="What “Top 10%” means" className="mb-5" />
          <p className="text-[15px] text-mute">
            Only 1 in 10 portfolios placed higher. The Code checks score sets the start; equal scores go by who was measured first.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {BANDS.map((b) => (
              <li key={b.band} className="card p-4">
                <span className="block text-lg font-bold tabular-nums">{b.band}</span>
                <span className="mt-2 flex gap-0.5" aria-hidden>
                  {Array.from({ length: 20 }, (_, i) => (
                    <span key={i} className={`h-2 flex-1 rounded-full ${i < b.of ? "bg-fill" : "bg-edge"}`} />
                  ))}
                </span>
                <span className="mt-1.5 block text-sm text-mute">{b.note}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* What's checked */}
        <section aria-labelledby="checked" className="mt-14">
          <SectionHeader id="checked" eyebrow="What's checked" title="Facts by code, a report card by AI" className="mb-5" />
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="card p-5 sm:p-6">
              <h3 className="flex items-center gap-2 font-bold">
                <Code2 className="h-4 w-4 text-mute" aria-hidden /> Code: yes or no
              </h3>
              <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
                {facts.map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />
                    {FACT_NAMES[c.id] ?? c.name}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card p-5 sm:p-6">
              <h3 className="flex items-center gap-2 font-bold">
                <Bot className="h-4 w-4 text-mute" aria-hidden /> Gemini report card: 1 to 5, from a screenshot and the text
              </h3>
              <p className="mt-1 text-sm text-mute">An opinion from one look. It never sets the rank; it can only flag a site that is not a portfolio.</p>
              <ul className="mt-4 grid gap-2.5 text-sm">
                {AI_CRITERIA.map((c) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 font-medium">{c.name}</span>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-edge" aria-hidden>
                      <span className="block h-full rounded-full bg-fill" style={{ width: `${(c.weight / 0.3) * 100}%` }} />
                    </span>
                    <span className="w-9 shrink-0 text-right text-xs text-mute tabular-nums">{pct(c.weight)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-3 text-sm text-mute">A grade describes the page, not the developer.</p>
        </section>

        {/* People's votes */}
        <section aria-labelledby="votes" className="mt-14">
          <SectionHeader id="votes" eyebrow="The ranking" title="How people's votes combine" className="mb-5" />
          <ol className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            {[
              { Icon: Code2, title: "Code checks", body: "Set the start" },
              { Icon: Swords, title: "Face-offs", body: "Move it up or down" },
              { Icon: Trophy, title: "Leaderboard", body: "Settles with more votes" },
            ].map(({ Icon, title, body }, i) => (
              <li key={title} className="contents">
                {i > 0 && <ChevronRight className="mx-auto h-5 w-5 self-center text-mute max-md:rotate-90" aria-hidden />}
                <span className="card flex items-center gap-3 p-4">
                  <span className="icon-tile h-10 w-10 shrink-0">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-semibold">{title}</span>
                    <span className="block text-sm text-mute">{body}</span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <ul className="mt-4 grid gap-1.5 text-sm text-mute">
            <li>A person&apos;s vote counts twice an AI vote.</li>
            <li>Beating a higher-ranked portfolio moves you more.</li>
            <li>Your report&apos;s Top X% uses grades only. Re-grade after {REGRADE_COOLDOWN_DAYS} days.</li>
          </ul>
        </section>

        <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
          {ROUTES.grade && (
            <a href={ROUTES.grade} className={btnPrimary}>
              Grade your portfolio <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          )}
          {ROUTES.faceoff && (
            <a href={ROUTES.faceoff} className={btnSecondary}>
              <Swords className="h-4 w-4" aria-hidden /> Vote in a face-off
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
