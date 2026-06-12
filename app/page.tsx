import feed from "@/data/feed.json";
import { SITE } from "@/lib/site";
import { Header } from "@/components/Header";
import { PortfolioGrid } from "@/components/PortfolioGrid";

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
  const portfolios = feed as Portfolio[];
  const stars = await getStarCount();

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <Header stars={stars} />

      <section className="py-16 text-center sm:py-24">
        <p className="fade-up text-sm font-medium tracking-widest text-accent uppercase">
          {portfolios.length.toLocaleString()} portfolios · community-curated
          since 2019
        </p>
        <h1
          className="fade-up mx-auto mt-4 max-w-2xl text-4xl font-bold tracking-tight text-balance sm:text-6xl"
          style={{ animationDelay: "80ms" }}
        >
          The best developer portfolios.{" "}
          <span className="text-accent">Ranked.</span>
        </h1>
        <p
          className="fade-up mx-auto mt-5 max-w-xl text-lg text-mute"
          style={{ animationDelay: "160ms" }}
        >
          Browse the web&apos;s largest collection of developer portfolios.
          Soon: head-to-head voting and AI scoring decide who rises to the
          top.
        </p>
        <div
          className="fade-up mt-8 flex items-center justify-center gap-3"
          style={{ animationDelay: "240ms" }}
        >
          <a
            href="#browse"
            className="rounded-lg bg-ink px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85"
          >
            Browse portfolios
          </a>
          <a
            href={SITE.github}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold transition hover:border-mute"
          >
            ★ Star on GitHub
          </a>
        </div>
      </section>

      <PortfolioGrid portfolios={portfolios} />

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
            href="https://github.com/n8watkins"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            n8watkins
          </a>
          .
        </p>
        <p className="mt-2">
          Want your portfolio here?{" "}
          <a
            href={`${SITE.github}#how-to-contribute`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-edge underline-offset-4 transition hover:text-ink"
          >
            Add it via PR
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
