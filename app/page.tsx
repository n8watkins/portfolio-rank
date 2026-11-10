import { ArrowRight, BookOpen, Swords, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { GradeForm } from "@/components/preview/GradeForm";
import { Newsletter } from "@/components/preview/Newsletter";
import { RankRow } from "@/components/preview/RankRow";
import { Shot } from "@/components/preview/Shot";
import { ViewTabs, type ViewKey } from "@/components/preview/ViewTabs";
import { YourPortfolio } from "@/components/preview/YourPortfolio";
import { Movement, SampleTag, card, sectionTitle } from "@/components/preview/bits";
import { climbers, hasRealGrades, leaderboard, rosterCount } from "@/lib/preview/data";
import { TAG_LABEL, posts } from "@/lib/preview/blog";
import { visitor } from "@/lib/preview/visitor";

export type Portfolio = { name: string; url: string; tagline?: string };

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  const total = rosterCount();
  const tops = Object.fromEntries(
    (["merged", "ai", "people"] as ViewKey[]).map((k) => [
      k,
      <div key={k}>
        <ol>
          {leaderboard(k)
            .slice(0, 10)
            .map((r) => (
              <RankRow key={r.url} r={r} view={k} />
            ))}
        </ol>
        <a href={`/top?view=${k}`} className="mt-2 inline-flex items-center gap-1 px-2 text-sm font-semibold text-accent hover:underline">
          Full leaderboard <ArrowRight className="h-4 w-4" aria-hidden />
        </a>
      </div>,
    ])
  ) as Record<ViewKey, React.ReactNode>;
  const climb = climbers(5);
  const latest = posts().slice(0, v.subscribed ? 3 : 2);
  const first = v.state === "first";

  return (
    <AppShell visitor={v} current="home">
      {first ? (
        <section id="grade" aria-labelledby="hero" className="scroll-mt-24 py-12 text-center sm:py-16">
          <h1 id="hero" className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            How good is your <span className="text-accent">portfolio</span>?
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[15px] text-mute text-pretty sm:text-lg">
            Paste a link. In about a minute you get a grade, where you'd rank among {total.toLocaleString()} developer portfolios, and the three things to fix first.
          </p>
          <div className="mx-auto mt-7 max-w-xl">
            <GradeForm />
          </div>
          <p className="mt-4 text-sm text-mute">
            Free, no account needed. Or{" "}
            <a href="/rank" className="font-semibold text-ink underline decoration-edge underline-offset-4 hover:decoration-accent">
              vote in a face-off
            </a>
            .
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-5 py-8 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:py-10">
          <YourPortfolio v={v} />
          <div className="grid grid-cols-1 content-start gap-5">
            <section id="grade" aria-labelledby="another" className={`${card} scroll-mt-24 p-5`}>
              <h2 id="another" className="text-base font-bold tracking-tight">
                Grade another
              </h2>
              <p className="mt-1 text-sm text-mute">A friend's, or a new version of yours.</p>
              <div className="mt-3">
                <GradeForm compact id="grade-another" />
              </div>
            </section>
            <a href="/rank" className={`${card} group flex items-center gap-3 p-5 transition hover:border-mute`}>
              <span className="grid grid-cols-1 h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                <Swords className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Vote in a face-off</span>
                <span className="block text-sm text-mute">Two portfolios, pick the better one.</span>
              </span>
              <ArrowRight className="h-4 w-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
            </a>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section aria-labelledby="top10" className={`${card} p-4 sm:p-5`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
            <h2 id="top10" className={sectionTitle}>
              Top 10
            </h2>
            <p className="flex items-center gap-2 text-xs text-mute">
              <span className="hidden sm:inline">{hasRealGrades() ? "AI: real Gemini grades. People and Merged:" : "All views:"}</span>
              <SampleTag what={hasRealGrades() ? "People and Merged rankings" : "Rankings"} />
            </p>
          </div>
          <ViewTabs label="Leaderboard view" panels={tops} />
        </section>

        <div className="grid grid-cols-1 content-start gap-5">
          <section aria-labelledby="climbers" className={`${card} p-4 sm:p-5`}>
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 id="climbers" className={`${sectionTitle} flex items-center gap-2`}>
                <TrendingUp className="h-4 w-4 text-up" aria-hidden /> This week's climbers
              </h2>
              <SampleTag />
            </div>
            <ol>
              {climb.map((r) => (
                <li key={r.url}>
                  <a href={`/grade/${r.slug}`} className="flex items-center gap-3 rounded-xl px-1 py-2 transition hover:bg-raised">
                    <Shot base={r.shot} alt="" domain={r.domain} className="aspect-square w-9 shrink-0 rounded-md border border-edge" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.name}</span>
                      <span className="block text-xs text-mute tabular-nums">Now #{r.rank}</span>
                    </span>
                    <Movement move={r.move} />
                  </a>
                </li>
              ))}
            </ol>
          </section>
          <a href="/how" className={`${card} group flex items-center gap-3 p-4 transition hover:border-mute sm:p-5`}>
            <BookOpen className="h-5 w-5 shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 text-sm">
              <span className="block font-semibold">How grading works</span>
              <span className="block text-mute">Every check, and what's measured vs judged by AI.</span>
            </span>
            <ArrowRight className="h-4 w-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
          </a>
        </div>
      </div>

      <section aria-labelledby="blog" className="mt-12">
        <div className="mb-4 flex items-end justify-between">
          <h2 id="blog" className={sectionTitle}>
            From the blog
          </h2>
          <a href="/blog" className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">
            All posts <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {latest.map((p) => (
            <a key={p.slug} href={`/blog/${p.slug}`} className={`${card} group flex flex-col p-5 transition hover:border-mute`}>
              <span className="flex items-center gap-2 text-xs text-mute">
                <span className="font-semibold uppercase tracking-wider text-accent">{TAG_LABEL[p.tags[0]] ?? p.tags[0]}</span>
                <span aria-hidden>·</span>
                {p.date}
                {p.status === "sample" ? <SampleTag className="ml-auto" what="Sample post" /> : <span className="ml-auto rounded-full border border-edge px-1.5 text-[10px] font-semibold uppercase tracking-wide">Draft</span>}
              </span>
              <span className="mt-3 block text-base font-bold leading-snug tracking-tight text-balance group-hover:text-accent">{p.title}</span>
              <span className="mt-2 block text-sm text-mute text-pretty">{p.subtitle}</span>
              <span className="mt-auto pt-4 text-xs text-mute">{p.minutes} min read</span>
            </a>
          ))}
          {!v.subscribed && <Newsletter />}
        </div>
      </section>
    </AppShell>
  );
}
