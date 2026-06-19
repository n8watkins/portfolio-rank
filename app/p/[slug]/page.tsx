import { notFound } from "next/navigation";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { DetailDiagnostics } from "@/components/Diagnostics";
import { BASE_ELO } from "@/lib/elo";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { db, ensureSchema } from "@/lib/db";

export const dynamic = "force-dynamic";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function PortfolioPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const url = decodeURIComponent(slug);
  const portfolio = (feed as Portfolio[]).find((p) => p.url === url);
  if (!portfolio) notFound();

  await ensureSchema();
  let rating = { elo: BASE_ELO, votes: 0 };
  const row = (
    await db().execute({
      sql: "SELECT elo, votes FROM ratings WHERE url = ?",
      args: [url],
    })
  ).rows[0];
  if (row) rating = { elo: Number(row.elo), votes: Number(row.votes) };

  const base = (await shotBases([url])).get(url);
  const shot = base ? heroOf(base) : mshotsUrl(url, 1200);

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6">
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

      <div className="mb-4 rounded-xl border border-edge bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">
              {portfolio.name}
            </h1>
            <p className="mt-1 text-sm text-mute">
              {portfolio.tagline ?? "Developer"} · {domainOf(url)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xl font-bold tabular-nums">{rating.elo}</p>
              <p className="text-xs text-mute">
                ELO · {rating.votes} vote{rating.votes === 1 ? "" : "s"}
              </p>
            </div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition hover:opacity-85"
            >
              Visit site ↗
            </a>
          </div>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shot}
          alt={`Screenshot of ${domainOf(url)}`}
          className="mt-4 aspect-[16/10] w-full rounded-lg border border-edge bg-edge object-cover object-top"
        />
      </div>

      <DetailDiagnostics url={url} />

      <p className="py-8 text-center text-xs text-mute">
        Diagnostics run live against the site and are cached. Think something
        is wrong?{" "}
        <a
          href="https://github.com/n8watkins/portfolio-rank/issues"
          className="underline underline-offset-4 hover:text-ink"
        >
          Open an issue
        </a>
        .
      </p>
    </div>
  );
}
