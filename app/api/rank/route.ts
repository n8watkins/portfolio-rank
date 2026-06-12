import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { BASE_ELO, eloUpdate } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import { isKnownPortfolio } from "@/lib/roster";
import { ANON_VOTE_LIMIT, DAILY_VOTE_LIMIT, getRater } from "@/lib/rater";
import { shotUrls } from "@/lib/shots";
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

async function countVotes(raterId: string, since?: string): Promise<number> {
  const res = await db().execute({
    sql: since
      ? `SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > ${since}`
      : "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?",
    args: [raterId],
  });
  return Number(res.rows[0].n);
}

export async function GET() {
  await ensureSchema();
  const rater = await getRater();
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

  const shots = await shotUrls([candidates[0].url, candidates[1].url]);
  const withRating = (p: Portfolio) => ({
    ...p,
    elo: ratings.get(p.url)?.elo ?? BASE_ELO,
    votes: ratings.get(p.url)?.votes ?? 0,
    shot: shots.get(p.url) ?? null,
  });

  const anonVotesUsed =
    rater.type === "anon" ? await countVotes(rater.id) : null;

  return NextResponse.json({
    a: withRating(candidates[0]),
    b: withRating(candidates[1]),
    rater: {
      signedIn: rater.type === "human",
      login: rater.login ?? null,
      anonVotesUsed,
      anonVoteLimit: ANON_VOTE_LIMIT,
    },
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
  if (!isKnownPortfolio(winner) || !isKnownPortfolio(loser)) {
    return NextResponse.json({ error: "unknown_url" }, { status: 403 });
  }

  await ensureSchema();
  const rater = await getRater();

  // One vote per pair per rater, in either direction.
  const dup = await db().execute({
    sql: `SELECT 1 FROM votes WHERE rater_id = ?
          AND ((winner = ? AND loser = ?) OR (winner = ? AND loser = ?))
          LIMIT 1`,
    args: [rater.id, winner, loser, loser, winner],
  });
  if (dup.rows.length > 0) {
    return NextResponse.json({ error: "already_voted" }, { status: 409 });
  }

  const daily = await countVotes(rater.id, "datetime('now', '-1 day')");
  if (daily >= DAILY_VOTE_LIMIT) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Anon votes are logged (they're still signal) but never move official ELO,
  // and after the free allowance the gate asks for GitHub sign-in.
  if (rater.type === "anon") {
    const used = await countVotes(rater.id);
    if (used >= ANON_VOTE_LIMIT) {
      return NextResponse.json(
        { error: "signin_required", anonVoteLimit: ANON_VOTE_LIMIT },
        { status: 403 }
      );
    }
  }

  const ratings = await getRatings([winner, loser]);
  const w = ratings.get(winner) ?? { elo: BASE_ELO, votes: 0 };
  const l = ratings.get(loser) ?? { elo: BASE_ELO, votes: 0 };
  const updated = eloUpdate(w.elo, l.elo);

  const insertVote = {
    sql: "INSERT INTO votes (winner, loser, rater_type, rater_id) VALUES (?, ?, ?, ?)",
    args: [winner, loser, rater.type, rater.id],
  };

  if (rater.type === "human") {
    const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
    await db().batch(
      [
        insertVote,
        { sql: upsert, args: [winner, updated.winner, w.votes + 1] },
        { sql: upsert, args: [loser, updated.loser, l.votes + 1] },
      ],
      "write"
    );
  } else {
    await db().execute(insertVote);
  }

  const anonVotesUsed =
    rater.type === "anon" ? await countVotes(rater.id) : null;

  return NextResponse.json({
    official: rater.type === "human",
    // For anon votes these are "what would have happened" — shown, not stored.
    winnerElo: updated.winner,
    loserElo: updated.loser,
    delta: updated.winner - w.elo,
    anonVotesUsed,
    anonVoteLimit: ANON_VOTE_LIMIT,
  });
}
