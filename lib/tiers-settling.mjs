// How far the library is from settled (owner, 2026-11-13): the face-offs it
// would take for every member to reach SETTLED_FACEOFFS, and how long that is
// at a given pace of people's votes, of Gemini one-on-one comparisons, and of
// Gemini batches of 5. A projection only: nothing here spends anything.
// scripts/settling.mjs prints it for a database; RANKING.md "Settling" keeps
// the latest numbers.
import { AI_VOTE_WEIGHT, SETTLED_FACEOFFS } from "./tiers.mjs";

/** A batch ranks this many portfolios at once: every pair in it is a comparison (5 sites, 10 pairs). */
export const BATCH_SIZE = 5;

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The plan for a library: `faceoffs` is each member's weighted face-off
 * count now. Each face-off gives both sides one (a person's vote) or
 * `aiWeight` (an AI comparison), so at best (two sites that both still need
 * face-offs every time) the face-offs needed are half the missing total.
 * { members, settled, missing (face-offs short, summed over members),
 *   pairs (all distinct pairs of members), people (face-offs needed from
 *   people's votes), oneOnOne (Gemini one-on-one comparisons needed), batches
 *   (Gemini batches of BATCH_SIZE needed) }.
 * @param {number[]} faceoffs
 * @param {{ target?: number, aiWeight?: number, batchSize?: number }} [options]
 */
export function settlingPlan(faceoffs, { target = SETTLED_FACEOFFS, aiWeight = AI_VOTE_WEIGHT, batchSize = BATCH_SIZE } = {}) {
  const members = faceoffs.length;
  const missing = round2(faceoffs.reduce((s, f) => s + Math.max(0, target - (Number(f) || 0)), 0));
  const settled = faceoffs.filter((f) => round2(Number(f) || 0) >= target).length;
  // A batch of k gives each of its sites k - 1 comparisons, each worth aiWeight.
  const perBatch = batchSize * (batchSize - 1) * aiWeight;
  return {
    members,
    settled,
    missing,
    pairs: (members * (members - 1)) / 2,
    people: Math.ceil(missing / 2),
    oneOnOne: aiWeight > 0 ? Math.ceil(missing / (2 * aiWeight)) : null,
    batches: perBatch > 0 ? Math.ceil(missing / perBatch) : null,
  };
}

/** Days to do `count` at `perDay` a day (whole days, rounded up). */
export const daysAt = (count, perDay) => (count && perDay > 0 ? Math.ceil(count / perDay) : 0);
