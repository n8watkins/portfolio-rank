import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { db, ensureSchema } from "@/lib/db";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leaderboard — PortfolioRank",
};

const MIN_VOTES = 3;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function TopPage() {
  await ensureSchema();
  const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));

  const res = await db().execute({
    sql: "SELECT url, elo, votes FROM ratings WHERE votes >= ? ORDER BY elo DESC LIMIT 100",
    args: [MIN_VOTES],
  });
  const ranked = res.rows
    .filter((r) => byUrl.has(String(r.url)))
    .map(
      (r) =>
        [String(r.url), { elo: Number(r.elo), votes: Number(r.votes) }] as const
    );

  const totalVotes = Number(
    (await db().execute("SELECT COUNT(*) AS n FROM votes")).rows[0]?.n ?? 0
  );

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a
          href="/rank"
          className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent transition hover:border-accent"
        >
          ⚔️ Cast votes
        </a>
      </header>

      <div className="py-6 text-center">
        <h1 className="text-3xl font-bold tracking-tight">🏆 Leaderboard</h1>
        <p className="mt-2 text-sm text-mute">
          Ranked by ELO from head-to-head votes.{" "}
          {Math.round(totalVotes).toLocaleString()} votes cast · minimum{" "}
          {MIN_VOTES} votes to qualify.
        </p>
      </div>

      {ranked.length === 0 ? (
        <p className="py-16 text-center text-sm text-mute">
          No portfolios have {MIN_VOTES}+ votes yet —{" "}
          <a href="/rank" className="text-accent underline underline-offset-4">
            go cast some
          </a>
          .
        </p>
      ) : (
        <ol className="space-y-2 pb-16">
          {ranked.map(([url, r], i) => {
            const p = byUrl.get(url)!;
            return (
              <li
                key={url}
                className="fade-up flex items-center gap-4 rounded-xl border border-edge bg-card px-4 py-3"
                style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
              >
                <span className="w-8 text-right text-lg font-bold tabular-nums text-mute">
                  {i + 1}
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${domainOf(url)}&sz=64`}
                  alt=""
                  className="h-8 w-8 rounded-md bg-edge"
                />
                <div className="min-w-0 flex-1">
                  <a
                    href={`/p/${encodeURIComponent(url)}`}
                    className="block truncate font-semibold hover:underline underline-offset-4"
                  >
                    {p.name}
                  </a>
                  <p className="truncate text-xs text-mute">
                    {p.tagline ?? domainOf(url)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold tabular-nums">{r.elo}</p>
                  <p className="text-xs text-mute">{r.votes} votes</p>
                </div>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-mute transition hover:text-ink"
                  title="Visit site"
                >
                  ↗
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
