import type { Metadata } from "next";
import { ArrowRight, Bot, CircleCheck, Code2, Swords, Users } from "lucide-react";
import { TierBadge } from "@/components/ui/badges";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { VERDICT } from "@/lib/grader/present.mjs";
import { ROUTES } from "@/lib/nav";
import { AI_CRITERIA, CODE_CRITERIA } from "@/pipeline/rubric.mjs";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";

// How grading works, in plain words: the tiers, what "top X%" means, what
// is checked and how people's votes combine with the grade. The lists come
// from the rubric (pipeline/rubric.mjs) and the report's own wording
// (lib/grader/present.mjs), so this page follows them when they change.

export const metadata: Metadata = {
  title: "How grading works - PortfolioRank",
  description:
    "What the S, A, B, C and D grades mean, what a top 10% place says, what code checks and what the AI judges, and how people's votes move the ranking.",
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const TIERS: { tier: keyof typeof VERDICT; name: string; note: string }[] = [
  { tier: "S", name: "Exceptional", note: "Rare on purpose: about one portfolio in twenty." },
  { tier: "A", name: "Strong", note: "Would stand out in most hiring pipelines." },
  { tier: "B", name: "Solid", note: "The most common grade. Usually one or two fixes from an A." },
  { tier: "C", name: "Weak", note: "The page doesn't yet make a case for you." },
  { tier: "D", name: "Needs work", note: "A visitor leaves without knowing who you are." },
];

const BANDS = [
  { band: "Top 5%", meaning: "Fewer than 1 in 20 graded portfolios rank above it." },
  { band: "Top 10%", meaning: "Ahead of nine in ten." },
  { band: "Top 25%", meaning: "Ahead of three in four." },
  { band: "Top half", meaning: "Ahead of most." },
  { band: "Below that", meaning: "Room to climb: the report lists the three fixes worth the most." },
];

// The facts that count, in the report's own words where it has them.
const FACT_NAMES: Record<string, string> = {
  contact: "A way to contact you",
  resume: "A resume or CV link",
  github: "A GitHub link",
  project_links: "Project and demo links that load",
  own_domain: "Your own domain, not a free subdomain",
  fresh_footer: "A footer year that isn't years old",
  original: "Not a known template",
};

const pct = (w: number) => `${Math.round(w * 100)}%`;

export default function GradingPage() {
  const facts = CODE_CRITERIA.filter((c) => c.weight > 0);
  return (
    <div className="pb-20">
      <section aria-labelledby="grading" className="band band-glow">
        <div className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
          <p className="rise text-xs font-semibold uppercase tracking-[0.14em] text-accent">Grading</p>
          <h1 id="grading" className="rise mt-2 text-4xl font-bold tracking-tight text-balance sm:text-5xl" style={d(40)}>
            How grading works
          </h1>
          <p className="rise mx-auto mt-4 max-w-2xl text-[15px] text-mute text-pretty sm:text-lg" style={d(80)}>
            Every portfolio gets a grade from S to D and a place among all graded portfolios. Code checks the facts, an AI judges how the page looks and reads, and
            people&apos;s votes in face-offs have the last word on the leaderboard.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        {/* The tiers */}
        <section aria-labelledby="tiers" className="mt-12">
          <SectionHeader id="tiers" eyebrow="The grade" title="Five tiers, S to D" className="mb-5" />
          <ul className="card divide-y divide-edge">
            {TIERS.map(({ tier, name, note }) => (
              <li key={tier} className="flex items-center gap-4 p-4 sm:p-5">
                <TierBadge tier={tier} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {tier}: {name}
                  </p>
                  <p className="mt-0.5 text-sm text-mute">
                    {VERDICT[tier]} {note}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-mute">
            The tier is the AI&apos;s overall call on the page, made with the measured facts in front of it. There is no S+: an S already means the very top.
          </p>
        </section>

        {/* Top X% */}
        <section aria-labelledby="place" className="mt-14">
          <SectionHeader id="place" eyebrow="Your place" title="What “Top 10%” means" className="mb-5" />
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-3 text-[15px] leading-relaxed text-mute">
              <p>
                A report also says where the portfolio lands among every portfolio graded so far: <strong className="text-ink">Top 10%</strong> means only one in
                ten graded portfolios placed higher.
              </p>
              <p>
                The tier sets the starting place and the AI&apos;s five scores order portfolios within a tier, so two B grades can sit far apart. The number
                moves as more portfolios are graded.
              </p>
            </div>
            <dl className="card divide-y divide-edge">
              {BANDS.map(({ band, meaning }) => (
                <div key={band} className="flex items-baseline gap-4 px-4 py-3 sm:px-5">
                  <dt className="w-24 shrink-0 font-semibold tabular-nums">{band}</dt>
                  <dd className="text-sm text-mute">{meaning}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* What's checked */}
        <section aria-labelledby="checked" className="mt-14">
          <SectionHeader id="checked" eyebrow="What's checked" title="Facts by code, quality by AI" className="mb-5" />
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="card p-5 sm:p-6">
              <h3 className="flex items-center gap-2 font-bold">
                <Code2 className="h-4 w-4 text-mute" aria-hidden /> Checked by code
              </h3>
              <p className="mt-1 text-sm text-mute">Yes or no, the same for everyone. They are what a hiring manager looks for first.</p>
              <ul className="mt-4 grid gap-2.5 text-sm">
                {facts.map((c) => (
                  <li key={c.id} className="flex items-center gap-2.5">
                    <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />
                    {FACT_NAMES[c.id] ?? c.name}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card p-5 sm:p-6">
              <h3 className="flex items-center gap-2 font-bold">
                <Bot className="h-4 w-4 text-mute" aria-hidden /> Judged by AI, 1 to 5
              </h3>
              <p className="mt-1 text-sm text-mute">Gemini reads one screenshot of the top of the page and its text.</p>
              <ul className="mt-4 grid gap-3 text-sm">
                {AI_CRITERIA.map((c) => (
                  <li key={c.id}>
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{c.name}</span>
                      <span className="shrink-0 text-xs text-mute tabular-nums">{pct(c.weight)} of the score</span>
                    </span>
                    <span className="mt-0.5 block text-mute">{c.what}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-3 text-sm text-mute">
            The AI judges how a page looks and reads, not whether the projects or the code behind them are good. A grade describes the page, not the developer.
          </p>
        </section>

        {/* People's votes */}
        <section aria-labelledby="votes" className="mt-14">
          <SectionHeader id="votes" eyebrow="The ranking" title="How people's votes combine" className="mb-5" />
          <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { Icon: Bot, title: "The grade sets the start", body: "A new portfolio starts where its grade puts it: an A starts above a B. Until people vote, that is all the ranking knows." },
              { Icon: Swords, title: "Face-offs move it", body: "Each face-off vote says which of two portfolios is better. Beating one rated higher moves a portfolio more than beating one rated lower." },
              { Icon: Users, title: "People count most", body: "The AI also votes, but a person's vote counts twice as much. The more votes, the surer the place: the leaderboard shows how settled each one is." },
            ].map(({ Icon, title, body }, i) => (
              <li key={title} className="card p-5">
                <span className="flex items-center gap-2.5">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-fill text-sm font-bold text-on-fill">{i + 1}</span>
                  <Icon className="h-4 w-4 text-mute" aria-hidden />
                </span>
                <p className="mt-3 font-semibold">{title}</p>
                <p className="mt-1 text-sm text-mute">{body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-mute">
            Your report&apos;s Top X% compares grades only, so it can differ from the leaderboard, where votes count. Changed your site? Grade it again after{" "}
            {REGRADE_COOLDOWN_DAYS} days.
          </p>
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
