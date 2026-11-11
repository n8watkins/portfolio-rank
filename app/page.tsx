import feed from "@/data/feed.json";
import { PortfolioGrid } from "@/components/PortfolioGrid";
import { TopMarquee } from "@/components/TopMarquee";
import { FAQ } from "@/components/FAQ";
import { AI_JUDGES } from "@/lib/rubric-copy";
import { hiddenUrls } from "@/lib/roster";

// Re-render at most every 5 min so the top-ranked marquee stays fresh without
// querying the DB on every request.
export const revalidate = 300;

export type Portfolio = {
  name: string;
  url: string;
  tagline?: string;
};

export default async function Home() {
  // Hide sites confirmed down or failing (lib/roster.hiddenUrls; the voting
  // pool and leaderboards filter them too).
  const hidden = await hiddenUrls();
  const portfolios = (feed as Portfolio[]).filter((p) => !hidden.has(p.url));

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div>
        <section className="py-10 text-center sm:py-14">
          <h1 className="fade-up mx-auto max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            The best developer portfolios.{" "}
            <span className="text-accent">Ranked.</span>
          </h1>
          <p
            className="fade-up mx-auto mt-4 max-w-xl text-sm text-mute sm:text-lg"
            style={{ animationDelay: "80ms" }}
          >
            {portfolios.length.toLocaleString()} community-curated portfolios.
            Your votes decide who rises.
          </p>
          <div
            className="fade-up mt-6 flex items-center justify-center gap-3"
            style={{ animationDelay: "160ms" }}
          >
            <a
              href="/rank"
              className="rounded-lg bg-fill px-5 py-2.5 text-sm font-semibold text-on-fill transition hover:opacity-85"
            >
              ⚔️ Start ranking
            </a>
            <a
              href="#browse"
              className="rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold transition hover:border-mute"
            >
              Browse
            </a>
          </div>
        </section>

        <TopMarquee />

        <PortfolioGrid portfolios={portfolios} />

        <FAQ aiJudges={AI_JUDGES} />
      </div>
    </div>
  );
}
