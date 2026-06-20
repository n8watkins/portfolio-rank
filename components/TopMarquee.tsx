import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";

// Auto-scrolling gallery of the top-ranked portfolios' hero shots — the homepage
// payoff: "static list in, browsable ranked gallery out." Pure CSS animation
// (see .marquee-track in globals.css); pauses on hover, off for reduced-motion.
export async function TopMarquee() {
  await ensureSchema();
  const res = await db().execute(
    "SELECT url, elo FROM ratings WHERE votes >= 1 ORDER BY elo DESC LIMIT 14"
  );
  const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));
  const ranked = res.rows
    .map((r) => ({ url: String(r.url), elo: Number(r.elo) }))
    .filter((r) => byUrl.has(r.url));
  if (ranked.length < 6) return null; // not enough ranked sites to be worth it

  const bases = await shotBases(ranked.map((r) => r.url));
  const items = ranked.map((r, i) => {
    const p = byUrl.get(r.url)!;
    const base = bases.get(r.url);
    return {
      rank: i + 1,
      url: r.url,
      name: p.name,
      elo: r.elo,
      shot: base ? heroOf(base) : mshotsUrl(r.url, 600),
    };
  });
  // Duplicate the set so translateX(-50%) loops seamlessly.
  const loop = [...items, ...items];

  return (
    <section className="mb-10" aria-label="Top-ranked portfolios">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-mute">
          🏆 Top ranked right now
        </h2>
        <a
          href="/top"
          className="text-xs font-semibold text-accent transition hover:underline"
        >
          Full leaderboard →
        </a>
      </div>
      <div className="relative -mx-4 overflow-hidden sm:-mx-6">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-bg to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-bg to-transparent" />
        <div className="marquee-track flex w-max px-4 sm:px-6">
          {loop.map((it, i) => {
            const dup = i >= items.length;
            return (
              <a
                key={`${it.url}-${i}`}
                href={`/p/${encodeURIComponent(it.url)}`}
                aria-hidden={dup}
                tabIndex={dup ? -1 : undefined}
                className="group mr-3 w-56 shrink-0 overflow-hidden rounded-xl border border-edge bg-card transition hover:border-accent"
              >
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={it.shot}
                    alt={`${it.name} — ranked #${it.rank}`}
                    loading="lazy"
                    className="aspect-[16/10] w-full bg-edge object-cover object-top"
                  />
                  <span className="absolute left-2 top-2 rounded-md bg-bg/80 px-1.5 py-0.5 text-xs font-bold text-accent backdrop-blur">
                    #{it.rank}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-xs font-semibold">
                    {it.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-mute">
                    {it.elo}
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
