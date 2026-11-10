import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { BASE_ELO, eloUpdate, pairKey } from "@/lib/elo";
import { db, ensureSchema } from "@/lib/db";
import { readAnonId } from "@/lib/matchup";
import { ANON_COOKIE, ANON_VOTE_LIMIT, DAILY_VOTE_LIMIT, accountTooNew, getRater } from "@/lib/rater";
import { mergeGuest } from "@/lib/games/merge.mjs";
import { gamesEnabled } from "@/lib/games/server";

// Fold a visitor's practice votes into their signed-in identity: each becomes
// an official human vote and moves ELO, except pairs they've already voted on
// signed-in (dropped - the existing vote stands).
//
// Guards against minting official votes:
// - only a practice cookie the server signed counts (a forged value claims nothing),
// - only practice votes cast on the pair the server last drew for that visitor
//   count (served = 1; visitors' redraws are capped, so nobody can fish),
// - an account converts at most ANON_VOTE_LIMIT practice votes in its lifetime,
//   and claiming counts against the same daily cap as live voting - both
//   re-checked inside each conversion's transaction, so concurrent claims
//   can't overspend,
// - accounts younger than MIN_GITHUB_ACCOUNT_AGE_DAYS (when set) claim nothing,
// - each converted vote stores the delta it applied and the time it was
//   claimed, so undo reverts it exactly.
// Idempotent: converted votes stop matching rater_type='anon', and the spent
// cookie is cleared at the end.
// With GAMES_V2 on, the guest's quizzes, badges and badge counters move to
// the account first (lib/games/merge.mjs).
export async function POST() {
  await ensureSchema();
  const rater = await getRater();
  if (rater.type !== "human") {
    return NextResponse.json({ error: "signin_required" }, { status: 401 });
  }

  // Games progress (quizzes, badges) moves to the account whatever its age
  // (lib/games/merge.mjs); the cookie stays for the votes below.
  if (gamesEnabled()) {
    const guest = readAnonId((await cookies()).get(ANON_COOKIE)?.value);
    if (guest) await mergeGuest(db(), { guest: `anon:${guest}`, account: rater.id });
  }

  // Leaves the practice votes (and the cookie) for when the account is old enough.
  if (accountTooNew(rater)) {
    return NextResponse.json({ claimed: 0, dropped: 0, error: "account_too_new" });
  }

  const jar = await cookies();
  const raw = jar.get(ANON_COOKIE)?.value;
  const anonId = readAnonId(raw);
  if (!anonId) {
    if (raw) jar.delete(ANON_COOKIE);
    return NextResponse.json({ claimed: 0, dropped: 0 });
  }

  const anon = await db().execute({
    sql: `SELECT id, winner, loser FROM votes
          WHERE rater_id = ? AND rater_type = 'anon' AND served = 1 ORDER BY id`,
    args: [`anon:${anonId}`],
  });

  const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
      elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;

  let claimed = 0;
  for (const row of anon.rows) {
    const voteId = Number(row.id);
    const winner = String(row.winner);
    const loser = String(row.loser);
    const key = pairKey(winner, loser);

    const tx = await db().transaction("write");
    try {
      // The budget is read inside the write transaction (libSQL serializes
      // them), so two claims racing each other can't both spend it.
      const budget = await tx.execute({
        sql: `SELECT
                (SELECT COUNT(*) FROM votes WHERE rater_id = ? AND created_at > datetime('now', '-1 day')) AS today,
                (SELECT COUNT(*) FROM votes WHERE rater_id = ? AND claimed = 1) AS claimed`,
        args: [rater.id, rater.id],
      });
      if (
        Number(budget.rows[0].today) >= DAILY_VOTE_LIMIT ||
        Number(budget.rows[0].claimed) >= ANON_VOTE_LIMIT
      ) {
        await tx.rollback();
        break; // out of budget - leave the rest as practice votes
      }
      const dup = await tx.execute({
        sql: "SELECT 1 FROM votes WHERE rater_id = ? AND pair_key = ? LIMIT 1",
        args: [rater.id, key],
      });
      if (dup.rows.length > 0) {
        await tx.execute({ sql: "DELETE FROM votes WHERE id = ?", args: [voteId] });
        await tx.commit();
        continue;
      }
      const res = await tx.execute({
        sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
        args: [winner, loser],
      });
      const ratings = new Map(
        res.rows.map((r) => [String(r.url), { elo: Number(r.elo), votes: Number(r.votes) }])
      );
      const w = ratings.get(winner) ?? { elo: BASE_ELO, votes: 0 };
      const l = ratings.get(loser) ?? { elo: BASE_ELO, votes: 0 };
      const updated = eloUpdate(w.elo, l.elo);
      const conv = await tx.execute({
        sql: `UPDATE votes SET rater_type = 'human', rater_id = ?, pair_key = ?, delta = ?,
                claimed = 1, created_at = datetime('now')
              WHERE id = ? AND rater_type = 'anon'`,
        args: [rater.id, key, updated.delta, voteId],
      });
      if (conv.rowsAffected === 0) {
        await tx.rollback(); // claimed concurrently by another request
        continue;
      }
      await tx.execute({ sql: upsert, args: [winner, updated.winner, w.votes + 1] });
      await tx.execute({ sql: upsert, args: [loser, updated.loser, l.votes + 1] });
      await tx.commit();
      claimed++;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  jar.delete(ANON_COOKIE);
  return NextResponse.json({ claimed, dropped: anon.rows.length - claimed });
}
