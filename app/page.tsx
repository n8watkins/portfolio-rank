import { ArrowRight, Sparkles } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { GradeForm } from "@/components/preview/GradeForm";
import { Showcase } from "@/components/preview/Showcase";
import { NewsletterFeature } from "@/components/preview/NewsletterFeature";
import { PlayBand } from "@/components/preview/PlayBand";
import { AboutCard, PortfolioOfTheDay } from "@/components/preview/PortfolioOfTheDay";
import { Climbers, FaceOffTeaser, LiveStats } from "@/components/preview/HomeCards";
import { PastPollsMini } from "@/components/preview/PastPolls";
import { PollCard } from "@/components/preview/PollCard";
import { polls } from "@/lib/preview/polls";
import { RankRow } from "@/components/preview/RankRow";
import { ViewTabs, type ViewKey } from "@/components/preview/ViewTabs";
import { YourPortfolio } from "@/components/preview/YourPortfolio";
import { SampleTag, sectionTitle } from "@/components/preview/bits";
import { hasRealGrades, leaderboard, rosterCount, showcaseSites } from "@/lib/preview/data";
import { TAG_LABEL, posts } from "@/lib/preview/blog";
import { visitor } from "@/lib/preview/visitor";

export type Portfolio = { name: string; url: string; tagline?: string };

export const dynamic = "force-dynamic";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

export default async function Home({ searchParams }: { searchParams: Promise<{ state?: string; hero?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const heroVariant = sp.hero === "b" ? "b" : "a";
  // Strong screenshots only: the hero is the first impression.
  const showcase = showcaseSites(6)
    .map((r) => ({ name: r.name, domain: r.domain, shot: r.shot, slug: r.slug, tier: r.grade!.tier, rank: r.rank }));
  const total = rosterCount();
  const tops = Object.fromEntries(
    (["merged", "ai", "people"] as ViewKey[]).map((k) => [
      k,
      <div key={k} className="flex flex-1 flex-col">
        <div className="flex items-center gap-3 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-mute" aria-hidden>
          <span className="w-9 text-right">#</span>
          <span className="flex-1">Portfolio</span>
          {k !== "ai" && <span className="w-8 text-right">Week</span>}
          <span className="w-12 text-right">{k === "people" ? "ELO" : "Score"}</span>
        </div>
        <ol className="flex flex-1 flex-col justify-between">
          {leaderboard(k)
            .slice(0, 10)
            .map((r) => (
              <RankRow key={r.url} r={r} view={k} />
            ))}
        </ol>
      </div>,
    ])
  ) as Record<ViewKey, React.ReactNode>;
  const latest = posts().slice(0, 3);
  const first = v.state === "first";
  const poll = polls();

  return (
    <AppShell visitor={v} current="home" bleed>
      {/* 1. Hero, or your portfolio */}
      <div className="band band-glow">
        <div className="wrap">
          {first ? (
            <section id="grade" aria-labelledby="hero" className="grid scroll-mt-24 grid-cols-1 items-center gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:py-24">
              <div className="text-center lg:text-left">
                <p className="rise mb-5 inline-flex items-center gap-2 rounded-full border border-edge bg-card px-3 py-1 text-xs font-medium text-mute shadow-[var(--card-hi)]">
                  <span className="attn-dot" aria-hidden /> {total.toLocaleString()} portfolios ranked by people and AI
                </p>
                <h1 className="rise text-4xl font-bold tracking-tight text-balance sm:text-6xl" style={d(60)}>
                  How good is your <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">portfolio</span>?
                </h1>
                <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg lg:mx-0" style={d(120)}>
                  Paste a link. In about a minute you get a grade, where you&apos;d rank among {total.toLocaleString()} developer portfolios, and the three things to fix first.
                </p>
                <div className="rise mx-auto mt-8 max-w-xl lg:mx-0" style={d(180)}>
                  <GradeForm />
                </div>
                <p className="rise mt-4 text-sm text-mute" style={d(240)}>
                  Free, no account needed. Or{" "}
                  <a href="/play" className="font-semibold text-ink underline decoration-edge-strong underline-offset-4 hover:decoration-accent">
                    play a round
                  </a>
                  .
                </p>
              </div>
              <div className="rise mx-auto w-full max-w-xl lg:max-w-none" style={d(200)}>
                <Showcase items={showcase} variant={heroVariant} />
              </div>
            </section>
          ) : (
            <div className="grid grid-cols-1 gap-5 py-10 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:py-14">
              <div className="rise flex">
                <YourPortfolio v={v} />
              </div>
              <div className="rise flex flex-col gap-5" style={d(80)}>
                <section id="grade" aria-labelledby="another" className="card scroll-mt-24 p-5">
                  <h2 id="another" className="flex items-center gap-2 text-base font-bold tracking-tight">
                    <Sparkles className="h-4 w-4 text-mute" aria-hidden /> Grade another
                  </h2>
                  <p className="mt-1 text-sm text-mute">A friend&apos;s, or a new version of yours.</p>
                  <div className="mt-3">
                    <GradeForm compact id="grade-another" />
                  </div>
                </section>
                <FaceOffTeaser className="flex-1" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. The rankings */}
      <div className="band band-raised band-rule py-14 lg:py-20">
        <div className="wrap">
          <SectionHead eyebrow="Rankings" title="Who's on top this week" href="/top" link="Full leaderboard" />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <section aria-labelledby="top10" className="rise card flex flex-col p-4 sm:p-6" style={d(first ? 300 : 160)}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-1">
                <h3 id="top10" className={sectionTitle}>
                  Top 10
                </h3>
                <p className="flex items-center gap-2 text-xs text-mute">
                  <span className="hidden sm:inline">{hasRealGrades() ? "AI: real Gemini grades. People and Merged:" : "All views:"}</span>
                  <SampleTag what={hasRealGrades() ? "People and Merged rankings" : "Rankings"} />
                </p>
              </div>
              <ViewTabs label="Leaderboard view" panels={tops} />
            </section>
            <div className="flex flex-col gap-5">
              <Climbers className="reveal flex flex-1 flex-col" />
              <LiveStats className="reveal" />
            </div>
          </div>
        </div>
      </div>

      {/* Play */}
      <div className="band band-glow py-14 lg:py-20">
        <div className="wrap">
          <SectionHead eyebrow="Play" title="Test your eye" href="/play" link="All games" />
          <PlayBand />
        </div>
      </div>

      {/* Portfolio of the day and About */}
      <div className="band pb-14 lg:pb-20">
        <div className="wrap reveal grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]">
          <PortfolioOfTheDay />
          <AboutCard />
        </div>
      </div>

      {/* 3. Have your say */}
      <div className="band py-14 lg:py-20">
        <div className="wrap">
          <SectionHead eyebrow="Community" title="Have your say" href="/polls" link="All polls" />
          <div className="reveal grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <PollCard poll={poll.active} showAll={false} />
            <PastPollsMini past={poll.past} />
          </div>
        </div>
      </div>

      {/* Newsletter */}
      {!v.subscribed && (
        <div className="band pb-14 lg:pb-20">
          <div className="wrap reveal">
            <NewsletterFeature id="home-nl" />
          </div>
        </div>
      )}

      {/* 4. From the blog */}
      <div className="band band-raised band-rule py-14 lg:py-20">
        <section aria-labelledby="blog" className="wrap">
          <SectionHead eyebrow="Blog" title="From the blog" id="blog" href="/blog" link="All posts" />
          <div className="reveal grid grid-cols-1 gap-5 md:grid-cols-3">
            {latest.map((p) => (
              <a key={p.slug} href={`/blog/${p.slug}`} className="card card-hover group flex flex-col p-5">
                <span className="flex items-center gap-2 text-xs text-mute">
                  <span className="font-semibold uppercase tracking-wider text-ink">{TAG_LABEL[p.tags[0]] ?? p.tags[0]}</span>
                  <span aria-hidden>·</span>
                  {p.date}
                  {p.status === "sample" ? (
                    <SampleTag className="ml-auto" what="Sample post" />
                  ) : (
                    <span className="ml-auto rounded-full border border-edge px-1.5 text-[10px] font-semibold uppercase tracking-wide">Draft</span>
                  )}
                </span>
                <span className="mt-3 block text-lg font-bold leading-snug tracking-tight text-balance transition group-hover:text-accent">{p.title}</span>
                <span className="mt-2 block text-sm text-mute text-pretty">{p.subtitle}</span>
                <span className="mt-auto flex items-center justify-between pt-4 text-xs text-mute">
                  {p.minutes} min read <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </span>
              </a>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function SectionHead({ eyebrow, title, href, link, id }: { eyebrow: string; title: string; href: string; link: string; id?: string }) {
  return (
    <div className="rise mb-7 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
        <h2 id={id} className="mt-1.5 text-2xl font-bold tracking-tight sm:text-3xl">
          {title}
        </h2>
      </div>
      <a href={href} className="group inline-flex items-center gap-1 text-sm font-semibold text-accent">
        {link} <ArrowRight className="nudge h-4 w-4" aria-hidden />
      </a>
    </div>
  );
}
