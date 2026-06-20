import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { raterStats } from "@/lib/stats";
import { ProfileLists } from "@/components/ProfileLists";
import { ProfileLikes, type LikeItem } from "@/components/ProfileLikes";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My profile — PortfolioRank",
};

const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-card p-4 text-center">
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs font-semibold text-mute">{label}</p>
      {sub && <p className="mt-0.5 text-[11px] text-mute">{sub}</p>}
    </div>
  );
}

export default async function ProfilePage() {
  const session = await auth();

  if (!session?.raterId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">My profile</h1>
        <p className="mt-3 text-sm text-mute">
          Sign in to see your stats, likes, and lists.
        </p>
        <a
          href="/api/auth/signin?callbackUrl=/profile"
          className="mt-6 inline-block rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg transition hover:opacity-85"
        >
          Sign in
        </a>
      </div>
    );
  }

  await ensureSchema();
  const stats = await raterStats(session.raterId);

  const likedRows = (
    await db().execute({
      sql: "SELECT url FROM likes WHERE rater_id = ? ORDER BY created_at DESC LIMIT 200",
      args: [session.raterId],
    })
  ).rows;
  const likes: LikeItem[] = likedRows
    .map((r) => String(r.url))
    .filter((url) => byUrl.has(url))
    .map((url) => ({
      url,
      name: byUrl.get(url)!.name,
      domain: domainOf(url),
    }));

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <a href="/rank" className="text-xs font-semibold text-accent">
          ⚔️ Keep ranking
        </a>
      </header>

      <div className="py-4">
        <h1 className="text-3xl font-bold tracking-tight">My profile</h1>
        <p className="mt-1 text-sm text-mute">
          Signed in as <span className="font-semibold">{session.login}</span>.
        </p>
      </div>

      <section className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Votes cast"
          value={stats.votes.toLocaleString()}
          sub="your ranking picks"
        />
        <StatCard
          label="Superstars"
          value={stats.starsAvailable}
          sub={`${stats.starsEarned} earned all-time`}
        />
        <StatCard label="Likes" value={stats.likes} sub="portfolios you ♥" />
        <StatCard label="Lists" value={stats.lists} sub="collections" />
      </section>

      <div className="mt-3 text-center sm:text-left">
        <a
          href="/votes"
          className="text-xs font-semibold text-mute underline underline-offset-2 transition hover:text-ink"
        >
          View full vote history →
        </a>
      </div>

      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Your lists</h2>
          <span className="text-xs text-mute">
            Make a list public to share it.
          </span>
        </div>
        <ProfileLists />
      </section>

      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            Your likes
            {likes.length > 0 && (
              <span className="ml-2 text-sm font-normal text-mute">
                {stats.likes}
              </span>
            )}
          </h2>
        </div>
        <ProfileLikes items={likes} />
      </section>
    </div>
  );
}
