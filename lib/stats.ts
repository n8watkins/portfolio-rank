import { db, ensureSchema } from "@/lib/db";
import { STAR_BANK_CAP, STAR_PER_VOTES } from "@/lib/rater";

export type RaterStats = {
  votes: number; // total votes this rater has cast (anon practice included for anon ids)
  starsEarned: number; // lifetime Superstars earned (1 per STAR_PER_VOTES votes)
  starsSpent: number; // super-votes already spent
  starsAvailable: number; // banked balance, capped at STAR_BANK_CAP
  likes: number; // portfolios this rater has liked
  lists: number; // named lists this rater owns
};

/**
 * Banked Superstar balance: earn 1 per STAR_PER_VOTES votes, bank up to
 * STAR_BANK_CAP. Single source of truth for the GET side of /api/rank and the
 * profile. (The vote POST recomputes this inside its write transaction so the
 * spend stays atomic — see app/api/rank/route.ts.)
 */
export async function starBalance(raterId: string): Promise<number> {
  const r = await db().execute({
    sql: "SELECT COUNT(*) AS total, COALESCE(SUM(starred), 0) AS spent FROM votes WHERE rater_id = ?",
    args: [raterId],
  });
  const total = Number(r.rows[0].total);
  const spent = Number(r.rows[0].spent);
  return Math.max(
    0,
    Math.min(Math.floor(total / STAR_PER_VOTES) - spent, STAR_BANK_CAP)
  );
}

/** Everything the profile shows about a signed-in rater, in one round-trip set. */
export async function raterStats(raterId: string): Promise<RaterStats> {
  await ensureSchema();
  const [v, likeRow, listRow] = await Promise.all([
    db().execute({
      sql: "SELECT COUNT(*) AS total, COALESCE(SUM(starred), 0) AS spent FROM votes WHERE rater_id = ?",
      args: [raterId],
    }),
    db().execute({
      sql: "SELECT COUNT(*) AS n FROM likes WHERE rater_id = ?",
      args: [raterId],
    }),
    db().execute({
      sql: "SELECT COUNT(*) AS n FROM lists WHERE owner = ?",
      args: [raterId],
    }),
  ]);
  const votes = Number(v.rows[0].total);
  const starsSpent = Number(v.rows[0].spent);
  const starsEarned = Math.floor(votes / STAR_PER_VOTES);
  const starsAvailable = Math.max(
    0,
    Math.min(starsEarned - starsSpent, STAR_BANK_CAP)
  );
  return {
    votes,
    starsEarned,
    starsSpent,
    starsAvailable,
    likes: Number(likeRow.rows[0].n),
    lists: Number(listRow.rows[0].n),
  };
}
