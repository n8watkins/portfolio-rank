export const metadata = {
  title: "How it works — PortfolioRank",
  description:
    "How PortfolioRank ranks developer portfolios: ELO from head-to-head votes, AI bootstrapping, and objective scorecards.",
};

export default function HowPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a
          href="/top"
          className="text-xs font-semibold text-mute transition hover:text-ink"
        >
          🏆 Leaderboard
        </a>
      </header>

      <div className="py-6">
        <h1 className="text-3xl font-bold tracking-tight">How it works</h1>
        <p className="mt-2 text-mute">
          A 1,700-portfolio list, turned into a ranking you can trust — by a mix
          of a crowd, an AI, and some boring-but-honest measurements.
        </p>
      </div>

      {/* Walkthrough video — placeholder until recorded. */}
      <div className="mb-10 flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-edge bg-card text-sm text-mute">
        🎬 Walkthrough video coming soon
      </div>

      <article className="mb-10">
        <h2 className="text-xl font-bold tracking-tight">
          📈 How the ELO ranking works
        </h2>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-mute">
          <p>
            The leaderboard uses <strong className="text-ink">ELO</strong> — the
            same system that ranks chess players. Instead of scoring each
            portfolio in a vacuum, it only ever asks one question:{" "}
            <em>&ldquo;which of these two is better?&rdquo;</em> Every answer
            nudges the two sites&apos; ratings.
          </p>
          <p>
            Everyone starts at <strong className="text-ink">1200</strong>. When
            you pick a winner, it gains points and the loser drops by the same
            amount — but <em>how many</em> points depends on the upset. Beat a
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
            earned ⭐ to make a vote count double — for the rare site you think is
            genuinely exceptional.
          </p>
          <p>
            And because every vote is logged, the entire ranking is{" "}
            <em>recomputable</em> — if a bad actor is ever found, their votes can
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
            Ranking 1,700 sites by hand is a non-starter, so an AI does the first
            pass. Each site gets a screenshot captured by a real browser; Gemini
            then looks at it and scores six things — visual design, the
            5-second test (is it clear who you are?), project storytelling,
            writing, memorability, and motion.
          </p>
          <p>
            For the leaderboard, the AI also votes head-to-head, the same way you
            do — but it weighs more than looks. Its comparison folds in the{" "}
            <strong className="text-ink">objective scorecard</strong> (Lighthouse
            performance + accessibility, plus polish signals like a custom
            domain and a working share card). A gorgeous page that&apos;s slow or
            inaccessible loses ground it would&apos;ve won on looks alone.
          </p>
          <p>
            The honest caveat:{" "}
            <strong className="text-ink">
              an AI judging a screenshot judges how something looks
            </strong>{" "}
            — not whether the projects are real or the code is good. That&apos;s
            exactly why it only <em>seeds</em> the ranking and humans get the
            final say. The model and prompt are fixed (one model, for
            consistency) and every AI vote is tagged, so its influence can always
            be separated out.
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
            freshness). These are facts, not votes — they live on each
            portfolio&apos;s own page so &ldquo;gorgeous but slow&rdquo; is shown,
            not averaged away.
          </p>
        </div>
      </article>
    </div>
  );
}
