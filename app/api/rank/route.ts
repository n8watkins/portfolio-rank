import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { BASE_ELO, eloUpdate, pairKey } from "@/lib/elo";
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
  const key = pairKey(winner, loser);

  // Everything — the limit checks, the vote insert, and the ELO update — runs
  // in one write transaction. libSQL serializes write transactions, so the
  // gaps that let concurrent requests slip past a check-then-insert (double
  // votes, blown caps, lost-update ELO inflation) are closed. The
  // UNIQUE(rater_id, pair_key) index is the final backstop for the dup check.
  const tx = await db().transaction("write");
  try {
    // Pace votes: a human looks at two screenshots before picking, a script
    // doesn't. Anything faster than one vote per 2s per rater is rejected.
    const recent = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-2 seconds')",
      args: [rater.id],
    });
    if (Number(recent.rows[0].n) > 0) {
      await tx.rollback();
      return NextResponse.json({ error: "too_fast" }, { status: 429 });
    }

    const daily = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-1 day')",
      args: [rater.id],
    });
    if (Number(daily.rows[0].n) >= DAILY_VOTE_LIMIT) {
      await tx.rollback();
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    // Anon votes are logged (they're still signal) but never move official ELO,
    // and after the free allowance the gate asks for sign-in.
    if (rater.type === "anon") {
      const used = await tx.execute({
        sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?",
        args: [rater.id],
      });
      if (Number(used.rows[0].n) >= ANON_VOTE_LIMIT) {
        await tx.rollback();
        return NextResponse.json(
          { error: "signin_required", anonVoteLimit: ANON_VOTE_LIMIT },
          { status: 403 }
        );
      }
    }

    const rres = await tx.execute({
      sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
      args: [winner, loser],
    });
    const map = new Map(
      rres.rows.map((r) => [
        String(r.url),
        { elo: Number(r.elo), votes: Number(r.votes) },
      ])
    );
    const w = map.get(winner) ?? { elo: BASE_ELO, votes: 0 };
    const l = map.get(loser) ?? { elo: BASE_ELO, votes: 0 };
    const updated = eloUpdate(w.elo, l.elo);

    // Insert first: a UNIQUE violation here means this rater already voted on
    // this matchup (either direction) — caught below as 409.
    await tx.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES (?, ?, ?, ?, ?)",
      args: [winner, loser, key, rater.type, rater.id],
    });

    if (rater.type === "human") {
      const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(url) DO UPDATE SET
          elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
      await tx.execute({ sql: upsert, args: [winner, updated.winner, w.votes + 1] });
      await tx.execute({ sql: upsert, args: [loser, updated.loser, l.votes + 1] });
    }

    await tx.commit();

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
  } catch (e) {
    await tx.rollback().catch(() => {});
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) {
      return NextResponse.json({ error: "already_voted" }, { status: 409 });
    }
    throw e;
  }
}
