import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import feed from "@/data/feed.json";
import { BASE_ELO, eloUpdate } from "@/lib/elo";
import type { Portfolio } from "@/app/page";

export const runtime = "nodejs";

// v0 storage: local JSON files. Replaced by Supabase when deployed —
// Vercel's filesystem is read-only, so this is local-dev only.
const RATINGS_FILE = path.join(process.cwd(), "data", "ratings.json");
const VOTE_LOG = path.join(process.cwd(), "data", "votes.jsonl");

type Ratings = Record<string, { elo: number; votes: number }>;

async function loadRatings(): Promise<Ratings> {
  try {
    return JSON.parse(await fs.readFile(RATINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function GET() {
  const pool = feed as Portfolio[];
  const ratings = await loadRatings();

  // Sample a handful of distinct entries, then face off the two least-voted
  // so every vote goes where the rating is most uncertain.
  const picked = new Map<number, Portfolio>();
  while (picked.size < 8) {
    const i = Math.floor(Math.random() * pool.length);
    picked.set(i, pool[i]);
  }
  const candidates = [...picked.values()].sort(
    (a, b) => (ratings[a.url]?.votes ?? 0) - (ratings[b.url]?.votes ?? 0)
  );

  const withRating = (p: Portfolio) => ({
    ...p,
    elo: ratings[p.url]?.elo ?? BASE_ELO,
    votes: ratings[p.url]?.votes ?? 0,
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

  const ratings = await loadRatings();
  const w = ratings[winner] ?? { elo: BASE_ELO, votes: 0 };
  const l = ratings[loser] ?? { elo: BASE_ELO, votes: 0 };
  const updated = eloUpdate(w.elo, l.elo);
  ratings[winner] = { elo: updated.winner, votes: w.votes + 1 };
  ratings[loser] = { elo: updated.loser, votes: l.votes + 1 };

  await fs.writeFile(RATINGS_FILE, JSON.stringify(ratings, null, 1));
  // Raw vote log so ELO can always be recomputed from scratch.
  await fs.appendFile(
    VOTE_LOG,
    JSON.stringify({
      winner,
      loser,
      rater: "local",
      at: new Date().toISOString(),
    }) + "\n"
  );

  return NextResponse.json({
    winnerElo: updated.winner,
    loserElo: updated.loser,
    delta: updated.winner - w.elo,
  });
}
