import { Swords, Trophy } from "lucide-react";
import { GradeForm } from "@/components/grade/GradeForm";
import { AboutCard, LiveCard, PastPolls, PlayBand, PortfolioOfTheDay, RecentlyGraded, TopTen } from "@/components/home/HomeCards";
import { BrowseRedirect } from "@/components/home/BrowseRedirect";
import { PollCard } from "@/components/home/PollCard";
import { Showcase } from "@/components/home/Showcase";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { gamesEnabled } from "@/lib/games/server";
import { graderEnabled } from "@/lib/grader/server";
import { homeData } from "@/lib/home";
import { ROUTES } from "@/lib/nav";

// Rendered at most every 5 minutes (ISR), the same page for everyone: every
// render costs database reads (docs/COSTS.md section C). What is the
// visitor's own (their poll vote, their grade) comes from the browser or
// lives on /me.
export const revalidate = 300;

export type Portfolio = {
  name: string;
  url: string;
  tagline?: string;
};

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

export default async function Home() {
  const data = await homeData();
  const grading = graderEnabled();
  const total = data.total.toLocaleString("en-US");
  const poll = data.polls;
  const hasPolls = Boolean(poll.active) || poll.past.length > 0;

  return (
    <>
      <BrowseRedirect />
      {/* 1. The hero: grade yours (or, while grading is off, vote), beside the best-graded portfolios */}
      <div className="band band-glow">
        <div className="wrap">
          <section aria-labelledby="hero" className="grid grid-cols-1 items-center gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:py-24">
            <div className="text-center lg:text-left">
              <p className="rise mb-5 inline-flex items-center gap-2 rounded-full border border-edge bg-card px-3 py-1 text-xs font-medium text-balance text-mute shadow-[var(--card-hi)]">
                <span className="attn-dot" aria-hidden /> {total} portfolios ranked by people and AI
              </p>
              {grading ? (
                <>
                  <h1 id="hero" className="rise text-4xl font-bold tracking-tight text-balance sm:text-6xl" style={d(60)}>
                    How good is your <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">portfolio</span>?
                  </h1>
                  <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg lg:mx-0" style={d(120)}>
                    Paste a link. In about a minute you get a grade, where you&apos;d rank among {total} developer portfolios, and the three things to fix first.
                  </p>
                  <div id="grade" className="rise mx-auto mt-8 max-w-xl scroll-mt-24 lg:mx-0" style={d(180)}>
                    <GradeForm center />
                  </div>
                  {ROUTES.play && (
                    <p className="rise mt-4 text-sm text-mute" style={d(240)}>
                      Free, no account needed. Or{" "}
                      <a href={ROUTES.play} className="font-semibold text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent">
                        play a round
                      </a>
                      .
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h1 id="hero" className="rise text-4xl font-bold tracking-tight text-balance sm:text-6xl" style={d(60)}>
                    The best developer portfolios,{" "}
                    <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">ranked</span>.
                  </h1>
                  <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg lg:mx-0" style={d(120)}>
                    {total} community-curated portfolios, graded by AI on design, first impression and writing. Your votes in face-offs decide who rises.
                  </p>
                  <div className="rise mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start" style={d(180)}>
                    {ROUTES.faceoff && (
                      <a href={ROUTES.faceoff} className={btnPrimary}>
                        <Swords className="icon-shake h-4 w-4" aria-hidden /> Vote in a face-off
                      </a>
                    )}
                    {ROUTES.top && (
                      <a href={ROUTES.top} className={btnSecondary}>
                        <Trophy className="h-4 w-4" aria-hidden /> See the leaderboard
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
            {data.showcase.length > 0 && (
              <div className="rise mx-auto w-full max-w-xl lg:max-w-none" style={d(200)}>
                <Showcase items={data.showcase} />
              </div>
            )}
          </section>
        </div>
      </div>

      {/* 2. The rankings */}
      <div className="band band-raised band-rule py-14 lg:py-20">
        <section aria-labelledby="rankings" className="wrap">
          <SectionHeader eyebrow="Rankings" title="Who's on top" id="rankings" href={ROUTES.top ?? undefined} link="Full leaderboard" className="rise mb-7" />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <TopTen top={data.top} className="rise" />
            <div className="flex flex-col gap-5">
              <RecentlyGraded items={data.recent} now={data.at} className="reveal flex flex-1 flex-col" />
              <LiveCard stats={data.stats} className="reveal" />
            </div>
          </div>
        </section>
      </div>

      {/* 3. Play */}
      {ROUTES.faceoff && data.showcase.length >= 2 && (
        <div className="band band-glow py-14 lg:py-20">
          <section aria-labelledby="play" className="wrap">
            <SectionHeader eyebrow="Play" title="Test your eye" id="play" href={ROUTES.play ?? undefined} link="All games" className="rise mb-7" />
            <PlayBand shots={data.showcase.slice(2)} guess={gamesEnabled()} />
          </section>
        </div>
      )}

      {/* 4. Portfolio of the day, and what this is */}
      {data.potd && (
        <div className="band pb-14 lg:pb-20">
          <div className="wrap reveal grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]">
            <PortfolioOfTheDay p={data.potd} />
            <AboutCard total={data.total} />
          </div>
        </div>
      )}

      {/* 5. Have your say */}
      {hasPolls && (
        <div className="band py-14 lg:py-20">
          <section aria-labelledby="polls" className="wrap">
            <SectionHeader eyebrow="Community" title="Have your say" id="polls" href={ROUTES.polls ?? undefined} link="All polls" className="rise mb-7" />
            <div className={`reveal grid grid-cols-1 gap-5 ${poll.active && poll.past.length ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : ""}`}>
              {poll.active && <PollCard poll={poll.active} />}
              {poll.past.length > 0 && <PastPolls past={poll.past} />}
            </div>
          </section>
        </div>
      )}

      {/* The newsletter and the blog join here once they have a back end and a route (ROUTES.blog). */}
    </>
  );
}
