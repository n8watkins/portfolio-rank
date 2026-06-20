import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { LeaderboardRest } from "@/components/LeaderboardRest";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leaderboard — PortfolioRank",
};

// Low during cold-start so the AI-seeded ELO has something to show; raise once
// human votes accrue.
const MIN_VOTES = 1;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// github.io sites encode the owner's handle in the subdomain.
function githubHandle(url: string): string | null {
  try {
    const m = new URL(url).hostname.toLowerCase().match(/^([a-z0-9-]+)\.github\.io$/);
    return m ? `@${m[1]}` : null;
  } catch {
    return null;
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
    .map((r) => ({ url: String(r.url), elo: Number(r.elo), votes: Number(r.votes) }))
    .filter((r) => byUrl.has(r.url))
    .map((r, i) => {
      const p = byUrl.get(r.url)!;
      return { ...r, rank: i + 1, name: p.name, tagline: p.tagline };
    });

  const totalVotes = Number(
    (await db().execute("SELECT COUNT(*) AS n FROM votes")).rows[0]?.n ?? 0
  );

  const mostLoved = (
    await db().execute(
      "SELECT winner AS url, COUNT(*) AS n FROM votes WHERE starred = 1 GROUP BY winner ORDER BY n DESC LIMIT 5"
    )
  ).rows
    .map((r) => ({ url: String(r.url), stars: Number(r.n) }))
    .filter((r) => byUrl.has(r.url))
    .map((r) => ({ ...r, name: byUrl.get(r.url)!.name }));

  const champ = ranked[0];
  const champBase = champ ? (await shotBases([champ.url])).get(champ.url) : undefined;
  const champShot = champ
    ? champBase
      ? heroOf(champBase)
      : mshotsUrl(champ.url, 1200)
    : null;
  const topFive = ranked.slice(1, 5); // #2–#5
  const rest = ranked.slice(5); // #6+

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
          {MIN_VOTES} {MIN_VOTES === 1 ? "vote" : "votes"} to qualify.
        </p>
        <p className="mx-auto mt-2 max-w-xl text-xs text-mute">
          This reflects crowd preference on look &amp; first impression — not a
          verdict on the developer. Early rankings are AI-seeded until enough
          human votes accrue. Objective measures (performance, accessibility,
          polish) live on each portfolio&apos;s own page.
        </p>
        <p className="mt-3">
          <a
            href="/how"
            className="text-xs font-semibold text-accent transition hover:underline"
          >
            How is this scored? →
          </a>
        </p>
      </div>

      {!champ ? (
        <p className="py-16 text-center text-sm text-mute">
          No portfolios have {MIN_VOTES}+ votes yet —{" "}
          <a href="/rank" className="text-accent underline underline-offset-4">
            go cast some
          </a>
          .
        </p>
      ) : (
        <>
          {/* Champion — the #1 spot gets the spotlight. */}
          <a
            href={`/p/${encodeURIComponent(champ.url)}`}
            className="fade-up mb-6 block overflow-hidden rounded-2xl border border-accent/50 bg-card transition hover:border-accent"
          >
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={champShot!}
                alt={`${champ.name} — #1`}
                className="aspect-[16/9] w-full bg-edge object-cover object-top"
              />
              <span className="absolute left-3 top-3 rounded-full bg-accent px-3 py-1 text-sm font-bold text-bg shadow">
                👑 #1
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate text-lg font-bold">{champ.name}</p>
                <p className="truncate text-sm text-mute">
                  {githubHandle(champ.url) ?? champ.tagline ?? domainOf(champ.url)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-2xl font-bold tabular-nums text-accent">
                  {champ.elo}
                </p>
                <p className="text-xs text-mute">{champ.votes} votes</p>
              </div>
            </div>
          </a>

          {topFive.length > 0 && (
            <div className="mb-2">
              <h2 className="mb-2 text-sm font-semibold text-mute">Top 5</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {topFive.map((e) => (
                  <a
                    key={e.url}
                    href={`/p/${encodeURIComponent(e.url)}`}
                    className="flex items-center gap-3 rounded-xl border border-edge bg-card px-4 py-3 transition hover:border-mute"
                  >
                    <span className="text-lg font-bold tabular-nums text-mute">
                      {e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : e.rank}
                    </span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${domainOf(e.url)}&sz=64`}
                      alt=""
                      className="h-8 w-8 rounded-md bg-edge"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{e.name}</p>
                      <p className="truncate text-xs text-mute">
                        {e.tagline ?? domainOf(e.url)}
                      </p>
                    </div>
                    <p className="shrink-0 font-bold tabular-nums">{e.elo}</p>
                  </a>
                ))}
              </div>
            </div>
          )}

          {rest.length > 0 && <LeaderboardRest entries={rest} />}

          {mostLoved.length > 0 && (
            <div className="mt-8 border-t border-edge pt-6 pb-16">
              <h2 className="mb-2 text-sm font-semibold text-mute">
                💖 Most Loved
              </h2>
              <div className="flex flex-wrap gap-2">
                {mostLoved.map((m) => (
                  <a
                    key={m.url}
                    href={`/p/${encodeURIComponent(m.url)}`}
                    className="flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-semibold transition hover:border-accent"
                  >
                    {m.name} <span className="text-accent">⭐ {m.stars}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
