import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { STAR_BANK_CAP, STAR_PER_VOTES, getRater } from "@/lib/rater";

export const runtime = "nodejs";

// Undo the current rater's most recent vote: delete the vote row and revert the
// exact ELO it applied (winner got +delta, loser got -delta) — all in one write
// transaction so it can't half-apply.
export async function POST() {
  await ensureSchema();
  const rater = await getRater();

  const tx = await db().transaction("write");
  try {
    const res = await tx.execute({
      sql: "SELECT id, winner, loser, rater_type, delta FROM votes WHERE rater_id = ? ORDER BY id DESC LIMIT 1",
      args: [rater.id],
    });
    const v = res.rows[0];
    if (!v) {
      await tx.rollback();
      return NextResponse.json({ error: "nothing_to_undo" }, { status: 404 });
    }

    await tx.execute({ sql: "DELETE FROM votes WHERE id = ?", args: [v.id] });

    // Only human votes touched ratings. Always decrement the vote counter (POST
    // always incremented it); the ELO term may be 0 for a lopsided matchup.
    const delta = v.delta == null ? 0 : Number(v.delta);
    if (String(v.rater_type) === "human") {
      await tx.execute({
        sql: "UPDATE ratings SET elo = elo - ?, votes = MAX(votes - 1, 0), updated_at = datetime('now') WHERE url = ?",
        args: [delta, String(v.winner)],
      });
      await tx.execute({
        sql: "UPDATE ratings SET elo = elo + ?, votes = MAX(votes - 1, 0), updated_at = datetime('now') WHERE url = ?",
        args: [delta, String(v.loser)],
      });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }

  // Fresh anon count so the practice meter can update.
  let anonVotesUsed: number | null = null;
  if (rater.type === "anon") {
    const c = await db().execute({
      sql: "SELECT COUNT(*) AS n FROM votes WHERE rater_id = ?",
      args: [rater.id],
    });
    anonVotesUsed = Number(c.rows[0].n);
  }
  // Undoing a super-vote frees its star — return the fresh balance so the UI re-enables ⭐.
  let stars = 0;
  if (rater.type === "human") {
    const sb = await db().execute({
      sql: "SELECT COUNT(*) AS total, COALESCE(SUM(starred), 0) AS spent FROM votes WHERE rater_id = ?",
      args: [rater.id],
    });
    stars = Math.max(
      0,
      Math.min(
        Math.floor(Number(sb.rows[0].total) / STAR_PER_VOTES) -
          Number(sb.rows[0].spent),
        STAR_BANK_CAP
      )
    );
  }
  return NextResponse.json({ ok: true, anonVotesUsed, stars });
}
