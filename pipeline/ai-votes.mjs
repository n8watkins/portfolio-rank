// Who an AI vote belongs to.
//
// rater_id is the voter's identity: UNIQUE(rater_id, pair_key) allows one vote
// per voter per matchup, and the judge skips pairs its rater_id already voted
// on. The flash-lite fallback chain (pipeline/gemini.mjs) is one logical judge,
// so every vote it casts uses one rater id, "ai:flash-lite", whichever model
// answered; the model that answered goes in votes.model. That way a day on the
// backup model can never vote a second time on a pair the primary already
// judged, and the leaderboard keeps exactly one AI voice per matchup.
//
// A model outside the chain (--model X --allow-model) is a different judge and
// votes as "ai:X".
import { FLASH_LITE_CHAIN } from "./gemini.mjs";

export const FLASH_LITE_RATER_ID = "ai:flash-lite";

export function raterIdFor(models) {
  return models.every((m) => FLASH_LITE_CHAIN.includes(m))
    ? FLASH_LITE_RATER_ID
    : `ai:${models[0]}`;
}

// Idempotent: adds votes.model (and votes.delta, normally added by the app's
// lib/db.ts) and folds votes cast under the old per-model
// rater ids ("ai:gemini-3.1-flash-lite", the only AI votes before 2026-11-10)
// into the logical rater id, keeping the model they came from. OR IGNORE
// leaves a row alone if the logical rater already voted on that pair.
export async function prepareAiVotes(db) {
  for (const column of ["model TEXT", "delta INTEGER"]) {
    try {
      await db.execute(`ALTER TABLE votes ADD COLUMN ${column}`);
    } catch {
      /* column already present */
    }
  }
  const legacy = FLASH_LITE_CHAIN.map((m) => `ai:${m}`);
  const res = await db.execute({
    sql: `UPDATE OR IGNORE votes
          SET model = COALESCE(model, substr(rater_id, 4)), rater_id = ?
          WHERE rater_type = 'ai' AND rater_id IN (${legacy.map(() => "?").join(",")})`,
    args: [FLASH_LITE_RATER_ID, ...legacy],
  });
  return res.rowsAffected;
}
