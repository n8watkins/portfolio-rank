import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { BASE_ELO, eloUpdate } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import { getRater } from "@/lib/rater";

export const runtime = "nodejs";

// Fold a visitor's anon practice votes into their signed-in identity: each
// becomes an official human vote and moves ELO, except pairs they've already
// voted on signed-in (the existing vote stands, the practice one is dropped).
// Idempotent — converted votes stop matching rater_type='anon', and the spent
// cookie is cleared at the end.
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

  const anon = await db().execute({
    sql: `SELECT id, winner, loser FROM votes
          WHERE rater_id = ? AND rater_type = 'anon' ORDER BY id`,
    args: [`anon:${anonId}`],
  });

  let claimed = 0;
  for (const row of anon.rows) {
    const voteId = Number(row.id);
    const winner = String(row.winner);
    const loser = String(row.loser);

    const dup = await db().execute({
      sql: `SELECT 1 FROM votes WHERE rater_id = ?
            AND ((winner = ? AND loser = ?) OR (winner = ? AND loser = ?))
            LIMIT 1`,
      args: [rater.id, winner, loser, loser, winner],
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
          sql: "UPDATE votes SET rater_type = 'human', rater_id = ? WHERE id = ?",
          args: [rater.id, voteId],
        },
        { sql: upsert, args: [winner, updated.winner, w.votes + 1] },
        { sql: upsert, args: [loser, updated.loser, l.votes + 1] },
      ],
      "write"
    );
    claimed++;
  }

  jar.delete("pr_anon");
  return NextResponse.json({ claimed, dropped: anon.rows.length - claimed });
}
