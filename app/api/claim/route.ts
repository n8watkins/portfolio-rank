import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { BASE_ELO, eloUpdate, pairKey } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import { getRater, DAILY_VOTE_LIMIT } from "@/lib/rater";

export const runtime = "nodejs";

// Fold a visitor's anon practice votes into their signed-in identity: each
// becomes an official human vote and moves ELO, except pairs they've already
// voted on signed-in (dropped — the existing vote stands). Claiming counts
// against the same daily cap as live voting, so churning fresh anon cookies
// can't be used to mint unlimited official votes. Idempotent: converted votes
// stop matching rater_type='anon', and the spent cookie is cleared at the end.
export async function POST() {
  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 401 });
  }

  const jar = await cookies();
  const anonId = jar.get("pr_anon")?.value;
  if (!anonId) {
    return NextResponse.json({ claimed: 0, dropped: 0 });
  }

  // Remaining official votes this rater may cast in the last 24h.
  const dailyRes = await db().execute({
    sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-1 day')",
    args: [rater.id],
  });
  let budget = DAILY_VOTE_LIMIT - Number(dailyRes.rows[0].n);

  const anon = await db().execute({
    sql: `SELECT id, winner, loser FROM votes
          WHERE rater_id = ? AND rater_type = 'anon' ORDER BY id`,
    args: [`anon:${anonId}`],
  });

  let claimed = 0;
  for (const row of anon.rows) {
    if (budget <= 0) break; // out of daily budget — leave the rest as anon
    const voteId = Number(row.id);
    const winner = String(row.winner);
    const loser = String(row.loser);

    const dup = await db().execute({
      sql: `SELECT 1 FROM votes WHERE rater_id = ? AND pair_key = ? LIMIT 1`,
      args: [rater.id, pairKey(winner, loser)],
    });
    if (dup.rows.length > 0) {
      await db().execute({
        sql: "DELETE FROM votes WHERE id = ?",
        args: [voteId],
      });
      continue;
    }

    const res = await db().execute({
      sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
      args: [winner, loser],
    });
    const ratings = new Map(
      res.rows.map((r) => [
        String(r.url),
        { elo: Number(r.elo), votes: Number(r.votes) },
      ])
    );
    const w = ratings.get(winner) ?? { elo: BASE_ELO, votes: 0 };
    const l = ratings.get(loser) ?? { elo: BASE_ELO, votes: 0 };
    const updated = eloUpdate(w.elo, l.elo);

    const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
    await db().batch(
      [
        {
          sql: "UPDATE votes SET rater_type = 'human', rater_id = ?, pair_key = ? WHERE id = ?",
          args: [rater.id, pairKey(winner, loser), voteId],
        },
        { sql: upsert, args: [winner, updated.winner, w.votes + 1] },
        { sql: upsert, args: [loser, updated.loser, l.votes + 1] },
      ],
      "write"
    );
    claimed++;
    budget--;
  }

  jar.delete("pr_anon");
  return NextResponse.json({ claimed, dropped: anon.rows.length - claimed });
}
