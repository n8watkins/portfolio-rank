import type { Metadata } from "next";
import { ArrowRight, Bot, ChevronRight, CircleCheck, Code2, Crown, Flag, Swords } from "lucide-react";
import { TierBadge } from "@/components/ui/badges";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ROUTES } from "@/lib/nav";
import { AI_CRITERIA, CODE_CRITERIA } from "@/pipeline/rubric.mjs";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";
import { AI_VOTE_WEIGHT, BELOW_TOP_TIERS, ELO_START, FAMILIES, MIN_FACEOFFS, STARTING_TIER, TIER_LADDER, distribution, familyOf, rankedCount } from "@/lib/tiers.mjs";
import { cachedLibrary } from "@/lib/tiers-store.mjs";
import { db, ensureSchema } from "@/lib/db";

// How grading works, kept short and public: tiers by ELO from face-offs (the
// ladder with today's counts), the fine print, how to climb, the grade as the
// report card, what is checked and how votes combine. The criteria come from
// the rubric (pipeline/rubric.mjs) and the tier settings from lib/tiers.mjs,
// so this page follows them when they change.

export const metadata: Metadata = {
  title: "How grading works - PortfolioRank",
  description: "How face-off votes set your tier from SSS to D, why everyone starts at B, and how the AI grade's report card helps you climb.",
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

// The ladder, from lib/tiers.mjs (the owner's settings).
/** Today's count in each tier, from the last refresh's library (lib/tiers-store.mjs); null when the database can't be read. */
async function liveCounts(): Promise<{ counts: Record<string, number>; total: number; ranked: number } | null> {
  try {
    await ensureSchema();
    const order = await cachedLibrary(db());
    return order.length ? { counts: distribution(order), total: order.length, ranked: rankedCount(order) } : null;
  } catch {
    return null;
  }
}

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
/** An AI comparison's weight in words: "a quarter" for 0.25. */
const share = (w: number) => ({ 0.25: "a quarter", 0.5: "half", 1: "the same" })[w] ?? `${w} of one`;

// The live counts change as grades land: re-rendered at most hourly.
export const revalidate = 3600;

export default async function GradingPage() {
  const live = await liveCounts();
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
            Face-offs set your tier. The AI grade is your report card: what to fix to climb.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        {/* The tiers, with today's counts */}
        <section aria-labelledby="tiers" className="mt-12">
          <SectionHeader id="tiers" eyebrow="Your tier" title="Your tier is your place by ELO" className="mb-3" />
          <ol className="grid max-w-2xl list-decimal gap-1.5 pl-5 text-[15px] text-pretty marker:font-semibold marker:text-accent">
            <li>
              Every portfolio starts at tier {STARTING_TIER}, with an ELO of {ELO_START.toLocaleString("en-US")}.
            </li>
            <li>
              Each face-off moves the ELO: win and it goes up, lose and it goes down. A person&apos;s vote counts fully, an AI
              comparison counts {share(AI_VOTE_WEIGHT)} as much.
            </li>
            <li>
              After {MIN_FACEOFFS} face-offs, your place among the portfolios that also have {MIN_FACEOFFS} sets your tier. Before that you
              stay at {STARTING_TIER}, so a few lucky votes can&apos;t make an S.
            </li>
          </ol>
          {live && (
            <p className="mt-3 text-sm text-mute">
              Today: {live.ranked.toLocaleString("en-US")} of {live.total.toLocaleString("en-US")} portfolios have {MIN_FACEOFFS} face-offs.
            </p>
          )}
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs uppercase tracking-wider text-mute">
                  <th className="py-2 pl-2 pr-3 font-medium">Tier</th>
                  <th className="py-2 pr-3 font-medium">Who gets it</th>
                  <th className="py-2 pr-2 text-right font-medium">Today</th>
                </tr>
              </thead>
              {FAMILIES.map((f) => (
                <tbody key={f.family} className="border-b border-edge last:border-b-0">
                  {TIER_LADDER.filter((t) => familyOf(t.tier) === f.family).map((t, i) => (
                    <tr key={t.tier} className={f.family === "A" ? "bg-accent-soft" : undefined}>
                      <td className="py-1.5 pl-2 pr-3">
                        <span className="flex items-center gap-3">
                          <TierBadge tier={t.tier} />
                          {(t.tier === "SSS" || i === (f.family === "S" ? 1 : 0)) && (
                            <span className={`font-semibold ${f.family === "A" ? "text-accent" : ""}`}>{t.tier === "SSS" ? "Elite" : f.name}</span>
                          )}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-mute">{t.note}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{live ? live.counts[t.tier].toLocaleString("en-US") : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <p className="mt-3 text-sm text-pretty">
            <strong className="font-semibold text-accent">A is the top 30%.</strong> <span className="text-mute">If your portfolio reaches A, it is ahead of most of the library: share it.</span>
          </p>
          <p className="mt-1.5 text-sm text-mute text-pretty">
            Tiers SSS to B&minus; are shown in public. C and D are not: the page says &ldquo;{BELOW_TOP_TIERS}&rdquo;, and only the owner sees the letter.
          </p>
        </section>

        {/* Caution, updates, grade and tier */}
        <section aria-labelledby="rules" className="mt-14">
          <SectionHeader id="rules" eyebrow="The fine print" title="A careful ELO, updates and the grade" className="mb-5" />
          <dl className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="card p-5">
              <dt className="font-bold">A careful ELO</dt>
              <dd className="mt-2 text-sm text-mute text-pretty">
                The ELO counts how sure we are, not just wins. With few face-offs it stays careful, so a new portfolio with three lucky
                wins doesn&apos;t jump past one that has won steadily for weeks.
              </dd>
            </div>
            <div className="card p-5">
              <dt className="font-bold">When it updates</dt>
              <dd className="mt-2 text-sm text-mute text-pretty">
                Every face-off counts. Tiers are placed again every hour, because other portfolios move too. Equal ELOs share a
                place.
              </dd>
            </div>
            <div className="card p-5">
              <dt className="font-bold">Grade or tier</dt>
              <dd className="mt-2 text-sm text-mute text-pretty">
                The AI grade doesn&apos;t set your tier. It is your report card: a score and a note for each part, so you know what to
                fix. It also decides whether a page is a portfolio at all.
              </dd>
            </div>
          </dl>
        </section>

        {/* How to improve */}
        <section aria-labelledby="improve" className="mt-14">
          <SectionHeader id="improve" eyebrow="Climbing" title="How to improve your tier" className="mb-5" />
          <ol className="grid max-w-2xl list-decimal gap-2 pl-5 text-[15px] text-pretty marker:font-semibold marker:text-accent">
            <li>Get into face-offs: share your page so people vote, and vote yourself. {MIN_FACEOFFS} face-offs earn your own tier.</li>
            <li>Read your report card on your portfolio&apos;s page and fix the weakest part first.</li>
            <li>Pass every code check: link a resume, your GitHub and a way to reach you; fix broken project links; use your own domain and a current footer year.</li>
            <li>Show each project with the problem, your part and the outcome, not just a list of tools.</li>
            <li>Make the first screen say who you are and what you do, in your own design.</li>
            <li>Re-grade after a real change, {REGRADE_COOLDOWN_DAYS} days after your last grade at the earliest.</li>
          </ol>
        </section>

        {/* Top X% */}
        <section aria-labelledby="place" className="mt-14">
          <SectionHeader id="place" eyebrow="Your place" title="What “Top 10%” means" className="mb-5" />
          <p className="text-[15px] text-mute">
            On the leaderboard, only 1 in 10 portfolios with {MIN_FACEOFFS} face-offs rank higher. On a grade report, it is where the
            grade itself stands among graded portfolios.
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
          <SectionHeader id="checked" eyebrow="The report card" title="Facts by code, quality by AI" className="mb-5" />
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
                <Bot className="h-4 w-4 text-mute" aria-hidden /> AI: 1 to 5, from a screenshot and the text
              </h3>
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
          <SectionHeader id="votes" eyebrow="The ranking" title="How face-offs make a tier" className="mb-5" />
          <ol className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            {[
              { Icon: Flag, title: `Start at ${STARTING_TIER}`, body: `ELO ${ELO_START.toLocaleString("en-US")}, the same for all` },
              { Icon: Swords, title: "Face-offs", body: "Move the ELO up or down" },
              { Icon: Crown, title: `${MIN_FACEOFFS} face-offs`, body: "Your place sets your tier" },
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
            <li>A person&apos;s vote counts fully; an AI comparison counts {share(AI_VOTE_WEIGHT)} as much, so tiers can move before many people vote.</li>
            <li>Beating a higher-rated portfolio moves you more.</li>
            <li>Your report&apos;s Top X% is about the grade only. Re-grade after {REGRADE_COOLDOWN_DAYS} days.</li>
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
