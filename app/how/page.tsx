import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";
import { AI_JUDGES, CODE_CHECKS, CODE_CONTEXT } from "@/lib/rubric-copy";

export const metadata = {
  title: "How it works - PortfolioRank",
  description:
    "How PortfolioRank ranks developer portfolios: ELO from head-to-head votes, AI bootstrapping, and objective scorecards.",
};

export default function HowPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
      <div>
        <div className="py-6">
          <h1 className="text-3xl font-bold tracking-tight">How it works</h1>
          <p className="mt-2 text-mute">
            A list of {PORTFOLIO_COUNT_LABEL} portfolios, turned into a ranking you
            can trust - by a mix of a crowd, an AI, and some boring-but-honest
            measurements.
          </p>
        </div>

        {/* Walkthrough video - placeholder until recorded. */}
        <div className="mb-10 flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-edge bg-card text-sm text-mute">
          🎬 Walkthrough video coming soon
        </div>

        <article className="mb-10">
          <h2 className="text-xl font-bold tracking-tight">
            📈 How the ELO ranking works
          </h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-mute">
            <p>
              The leaderboard uses <strong className="text-ink">ELO</strong> - the
              same system that ranks chess players. Instead of scoring each
              portfolio in a vacuum, it only ever asks one question:{" "}
              <em>&ldquo;which of these two is better?&rdquo;</em> Every answer
              nudges the two sites&apos; ratings.
            </p>
            <p>
              Everyone starts at <strong className="text-ink">1200</strong>. When
              you pick a winner, it gains points and the loser drops by the same
              amount - but <em>how many</em> points depends on the upset. Beat a
              site rated far above you and you jump a lot; beat one far below and
              you barely move (you were supposed to win). That self-correcting math
              is why a handful of votes can sort thousands of sites sensibly.
            </p>
            <p>
              Two twists specific to here:{" "}
              <strong className="text-ink">AI seeds, humans refine.</strong> Before
              any people vote, Gemini casts the first rounds so the board
              isn&apos;t empty on day one; then real votes take over.{" "}
              <strong className="text-ink">Superstars</strong> let you spend an
              earned ⭐ to make a vote count double - for the rare site you think is
              genuinely exceptional.
            </p>
            <p>
              And because every vote is logged, the entire ranking is{" "}
              <em>recomputable</em> - if a bad actor is ever found, their votes can
              be removed and the board rebuilt from scratch.
            </p>
          </div>
        </article>

        <article className="mb-10">
          <h2 className="text-xl font-bold tracking-tight">
            🤖 How the AI judging works
          </h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-mute">
            <p>
              A real browser captures each of the {PORTFOLIO_COUNT_LABEL} sites, and{" "}
              <strong className="text-ink">code measures the facts that rank it</strong>. Code
              checks {CODE_CHECKS}, which add up to a checks score; it also records{" "}
              {CODE_CONTEXT} as context, without scoring them. A site&apos;s starting
              rank comes from those measurements, and votes move it from there.
            </p>
            <p>
              Gemini then takes one look, and its answer is{" "}
              <strong className="text-ink">a separate opinion that never changes the rank</strong>.
              It reads the screenshot and the page&apos;s text and is asked three things
              and nothing else: whether the site is a portfolio at all, the {AI_JUDGES}{" "}
              (can a visitor tell who you are and what you do, scored 1 to 5), and which
              roles you name for yourself. A &ldquo;not a portfolio&rdquo; answer can take
              a site off the list, with a record the owner can undo.
            </p>
            <p>
              The honest caveat:{" "}
              <strong className="text-ink">
                an AI looking at a screenshot sees how something looks
              </strong>{" "}
              - not whether the projects are real or the code is good. That&apos;s
              why it is asked so little, and why the rank is code&apos;s and
              people&apos;s. The model and prompt are fixed (one model, for
              consistency).
            </p>
            <p>
              What each grade means and what goes into it:{" "}
              <a href="/grading" className="font-semibold text-accent hover:underline">
                how grading works
              </a>
              .
            </p>
          </div>
        </article>

        <article>
          <h2 className="text-xl font-bold tracking-tight">
            📊 The objective scorecards
          </h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-mute">
            <p>
              Opinions aside, every portfolio also gets measured. We run Google
              <strong className="text-ink"> Lighthouse</strong> (performance,
              accessibility, best-practices, SEO) and a{" "}
              <strong className="text-ink">polish checklist</strong> (HTTPS, custom
              domain, social share card, favicon, links to GitHub/resume/contact,
              freshness). These are facts, not votes - they live on each
              portfolio&apos;s own page so &ldquo;gorgeous but slow&rdquo; is shown,
              not averaged away.
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}
