import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { db, ensureSchema } from "@/lib/db";

// Compact, always-visible Top 5 — "here's what you'd have to beat" — distinct
// from the scrolling marquee. No screenshots, just rank + name + ELO.
export async function TopFive() {
  await ensureSchema();
  const res = await db().execute(
    "SELECT url, elo FROM ratings WHERE votes >= 1 ORDER BY elo DESC LIMIT 5"
  );
  const byUrl = new Map((feed as Portfolio[]).map((p) => [p.url, p]));
  const rows = res.rows
    .map((r) => ({ url: String(r.url), elo: Number(r.elo) }))
    .filter((r) => byUrl.has(r.url))
    .map((r, i) => ({ ...r, rank: i + 1, name: byUrl.get(r.url)!.name }));
  if (rows.length < 2) return null;

  return (
    <section className="mb-8 max-w-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">🏆 Top 5 right now</h2>
        <a
          href="/top"
          className="text-xs font-semibold text-accent transition hover:underline"
        >
          Full →
        </a>
      </div>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <a
            key={r.url}
            href={`/p/${encodeURIComponent(r.url)}`}
            className="flex items-center gap-3 rounded-lg border border-edge bg-card px-3 py-2 transition hover:border-accent"
          >
            <span className="w-5 text-sm font-bold tabular-nums text-accent">
              {r.rank}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {r.name}
            </span>
            <span className="text-xs tabular-nums text-mute">{r.elo}</span>
          </a>
        ))}
      </ol>
    </section>
  );
}
