import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { auth } from "@/auth";
import { SignInButton } from "@/components/SignInModal";
import { db, ensureSchema } from "@/lib/db";
import { profilePath } from "@/lib/profile-url.mjs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My votes - PortfolioRank",
  // Personal: never in search results.
  robots: { index: false },
};

const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Entry({ url, won }: { url: string; won: boolean }) {
  const p = byUrl.get(url);
  return (
    <a
      href={profilePath(url)}
      className={`truncate text-sm underline-offset-2 hover:underline ${
        won ? "font-semibold" : "text-mute"
      }`}
    >
      {won ? "✓ " : ""}
      {p?.name ?? domainOf(url)}
    </a>
  );
}

export default async function VotesPage() {
  const session = await auth();

  if (!session?.raterId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">My votes</h1>
        <p className="mt-3 text-sm text-mute">
          Sign in to see your voting history.
        </p>
        <SignInButton
          className="mt-6 inline-block min-h-11 rounded-lg bg-fill px-5 py-2 text-sm font-semibold text-on-fill transition hover:opacity-85"
          title="Sign in to PortfolioRank"
          body="See your stats, votes, likes and lists. One account, one vote per matchup."
        />
      </div>
    );
  }

  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT winner, loser, created_at FROM votes
          WHERE rater_id = ? ORDER BY id DESC LIMIT 500`,
    args: [session.raterId],
  });

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 sm:px-6">
      <div>
        <h1 className="pt-4 text-2xl font-bold tracking-tight">My votes</h1>
        <p className="mt-1 pb-6 text-sm text-mute">
          {res.rows.length} vote{res.rows.length === 1 ? "" : "s"} as{" "}
          <span className="font-semibold">{session.login}</span> - every pick
          links to the portfolio, so this doubles as your bookmarks.
        </p>

        {res.rows.length === 0 ? (
          <p className="pb-16 text-sm text-mute">
            No votes yet -{" "}
            <a href="/play" className="text-accent underline underline-offset-2">
              go rank some portfolios
            </a>
            .
          </p>
        ) : (
          <ul className="space-y-2 pb-16">
            {res.rows.map((r, i) => (
              <li
                key={i}
                className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3 rounded-lg border border-edge bg-card px-4 py-2.5"
              >
                <Entry url={String(r.winner)} won />
                <span className="text-xs text-mute">beat</span>
                <Entry url={String(r.loser)} won={false} />
                <span className="text-xs tabular-nums text-mute">
                  {String(r.created_at).slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
