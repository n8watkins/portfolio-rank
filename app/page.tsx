import feed from "@/data/feed.json";
import { SITE } from "@/lib/site";
import { Header } from "@/components/Header";
import { PortfolioGrid } from "@/components/PortfolioGrid";
import { TopMarquee } from "@/components/TopMarquee";
import { TopFive } from "@/components/TopFive";
import { FAQ } from "@/components/FAQ";
import { db, ensureSchema } from "@/lib/db";

// Re-render at most every 5 min so the top-ranked marquee stays fresh without
// querying the DB on every request.
export const revalidate = 300;

export type Portfolio = {
  name: string;
  url: string;
  tagline?: string;
};

async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${SITE.githubRepo}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.stargazers_count ?? null;
  } catch {
    return null;
  }
}

export default async function Home() {
  // Hide sites we've confirmed dead/parked/error from browse (voting already
  // only uses live ones). Unconfirmed (pending/live) stay in.
  await ensureSchema();
  const excluded = new Set(
    (
      await db().execute(
        "SELECT url FROM portfolios WHERE status IN ('dead', 'parked', 'error')"
      )
    ).rows.map((r) => String(r.url))
  );
  const portfolios = (feed as Portfolio[]).filter((p) => !excluded.has(p.url));
  const stars = await getStarCount();

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <Header stars={stars} />

      <section className="py-8 text-center sm:py-10">
        <h1 className="fade-up mx-auto max-w-2xl text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          The best developer portfolios.{" "}
          <span className="text-accent">Ranked.</span>
        </h1>
        <p
          className="fade-up mx-auto mt-3 max-w-xl text-sm text-mute sm:text-base"
          style={{ animationDelay: "80ms" }}
        >
          {portfolios.length.toLocaleString()} community-curated portfolios.
          Your votes decide who rises.
        </p>
        <div
          className="fade-up mt-5 flex items-center justify-center gap-3"
          style={{ animationDelay: "160ms" }}
        >
          <a
            href="/rank"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85"
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

      <TopFive />

      <TopMarquee />

      <PortfolioGrid portfolios={portfolios} />

      <FAQ />

      <footer className="mt-20 border-t border-edge py-10 text-center text-sm text-mute">
        <p>
          List curated by{" "}
          <a
            href="https://github.com/emmabostian/developer-portfolios"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            Emma Bostian &amp; 1,700+ contributors
          </a>
          . Built by{" "}
          <a
            href={SITE.n8builds}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            n8builds.dev
          </a>
          .
        </p>
        <p className="mt-2">
          Want your portfolio here?{" "}
          <a
            href={SITE.submit}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            Submit it
          </a>{" "}
          — takes 30 seconds with a GitHub account.
        </p>
        <p className="mt-2 text-xs">
          On the list and want off?{" "}
          <a
            href={SITE.remove}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            Remove my portfolio
          </a>
          .
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <a
            href={SITE.kofi}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition hover:opacity-85"
          >
            ☕ Support on Ko-fi
          </a>
          <a
            href={SITE.n8builds}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-edge px-4 py-2 text-sm font-semibold transition hover:border-mute"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/n8-logo.png" alt="" className="h-4 w-4 rounded" />
            n8builds.dev
          </a>
        </div>
      </footer>
    </div>
  );
}
