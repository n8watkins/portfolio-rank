import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { BASE_ELO, eloUpdate } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import type { Portfolio } from "@/app/page";

export const runtime = "nodejs";

type Rating = { elo: number; votes: number };

async function getRatings(urls: string[]): Promise<Map<string, Rating>> {
  const placeholders = urls.map(() => "?").join(",");
  const res = await db().execute({
    sql: `SELECT url, elo, votes FROM ratings WHERE url IN (${placeholders})`,
    args: urls,
  });
  return new Map(
    res.rows.map((r) => [
      String(r.url),
      { elo: Number(r.elo), votes: Number(r.votes) },
    ])
  );
}

export async function GET() {
  await ensureSchema();
  const pool = feed as Portfolio[];

  // Sample a handful of distinct entries, then face off the two least-voted
  // so every vote goes where the rating is most uncertain.
  const picked = new Map<number, Portfolio>();
  while (picked.size < 8) {
    const i = Math.floor(Math.random() * pool.length);
    picked.set(i, pool[i]);
  }
  const candidates = [...picked.values()];
  const ratings = await getRatings(candidates.map((p) => p.url));
  candidates.sort(
    (a, b) => (ratings.get(a.url)?.votes ?? 0) - (ratings.get(b.url)?.votes ?? 0)
  );

  const withRating = (p: Portfolio) => ({
    ...p,
    elo: ratings.get(p.url)?.elo ?? BASE_ELO,
    votes: ratings.get(p.url)?.votes ?? 0,
  });

  return NextResponse.json({
    a: withRating(candidates[0]),
    b: withRating(candidates[1]),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const winner = body?.winner;
  const loser = body?.loser;
  if (
    typeof winner !== "string" ||
    typeof loser !== "string" ||
    winner === loser
  ) {
    return NextResponse.json({ error: "bad_vote" }, { status: 400 });
  }

  await ensureSchema();
  const ratings = await getRatings([winner, loser]);
  const w = ratings.get(winner) ?? { elo: BASE_ELO, votes: 0 };
  const l = ratings.get(loser) ?? { elo: BASE_ELO, votes: 0 };
  const updated = eloUpdate(w.elo, l.elo);

  const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
      elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;

  // TODO(auth): rater_id becomes the GitHub user / anon session id, with
  // per-rater rate limits and pair dedupe.
  await db().batch(
    [
      {
        sql: "INSERT INTO votes (winner, loser, rater_type, rater_id) VALUES (?, ?, 'anon', 'local')",
        args: [winner, loser],
      },
      { sql: upsert, args: [winner, updated.winner, w.votes + 1] },
      { sql: upsert, args: [loser, updated.loser, l.votes + 1] },
    ],
    "write"
  );

  return NextResponse.json({
    winnerElo: updated.winner,
    loserElo: updated.loser,
    delta: updated.winner - w.elo,
  });
}
