// The rating behind tiers by ELO (lib/tiers.mjs): every face-off replayed in
// time order through OpenSkill (lib/ranking/engine.mjs, Plackett-Luce), from
// a start that is the same for everyone (no AI-grade seed).
//
//   a person's vote     counts fully (a Superstar vote twice, as in the ELO board)
//   an AI comparison    counts AI_VOTE_WEIGHT of one: it moves the rating and
//                       shrinks its uncertainty by that share, and adds that
//                       share to the face-off count
//
// Only one-on-one results count: practice votes, skips, experiments and the
// batched AI rankings (still an experiment, RANKING.md) never do.
//
// Pure and deterministic: the same comparisons always give the same ratings.
// Kept apart from lib/tiers.mjs so the browser never loads OpenSkill.
import { rateRanking } from "./ranking/engine.mjs";
import { MU, SIGMA_UNSURE, STARRED_WEIGHT } from "./ranking/config.mjs";
import { parseRanking, toIso } from "./ranking/views.mjs";
import { AI_VOTE_WEIGHT } from "./tiers.mjs";

/**
 * Rates every portfolio from its face-offs.
 *   comparisons  [{ id, created_at, rater_type ("human" | "ai"), method,
 *                ranking (best first, JSON or array), outcome, starred,
 *                experiment }]
 *   seeds        url -> { mu, sigma }: starting ratings from automated checks
 *                (lib/tiers-store.mjs); anyone else starts fresh
 * Returns url -> { mu, sigma, faceoffs (weighted), wins, losses, won (wins,
 * weighted: an AI win counts aiWeight of one) } for every
 * seeded portfolio and every one with face-offs (anyone else has the fresh
 * rating). No vote is invented: a seed is only where the replay starts.
 */
export function rateFaceoffs(comparisons, { aiWeight = AI_VOTE_WEIGHT, seeds = new Map() } = {}) {
  const state = new Map();
  for (const [url, s] of seeds) state.set(url, { mu: s.mu, sigma: s.sigma, faceoffs: 0, wins: 0, losses: 0, won: 0 });
  const get = (url) => state.get(url) ?? { mu: MU, sigma: SIGMA_UNSURE, faceoffs: 0, wins: 0, losses: 0, won: 0 };
  const events = comparisons
    .filter((c) => c && c.outcome !== "skip" && !c.experiment && c.method === "one_on_one" && (c.rater_type === "human" || (c.rater_type === "ai" && aiWeight > 0)))
    .map((c) => ({ c, at: toIso(c.created_at), id: Number(c.id ?? 0) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  for (const { c } of events) {
    const ranking = parseRanking(c.ranking);
    // A face-off is one winner and one loser.
    if (!ranking || ranking.length !== 2 || ranking[0].length !== 1 || ranking[1].length !== 1) continue;
    const human = c.rater_type === "human";
    const weight = human ? (c.starred ? STARRED_WEIGHT : 1) : aiWeight;
    const count = human ? 1 : aiWeight;
    const out = rateRanking(get, ranking, weight);
    if (!out) continue;
    const [winner, loser] = [ranking[0][0], ranking[1][0]];
    for (const [url, r] of out) {
      const s = get(url);
      state.set(url, { mu: r.mu, sigma: r.sigma, faceoffs: s.faceoffs + count, wins: s.wins + (url === winner ? 1 : 0), losses: s.losses + (url === loser ? 1 : 0), won: s.won + (url === winner ? count : 0) });
    }
  }
  return state;
}
