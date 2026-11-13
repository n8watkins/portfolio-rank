// Which portfolios a Play face-off draws from (app/api/rank GET): mostly
// ones that still need face-offs for their own tier (lib/tiers.mjs
// MIN_FACEOFFS), so everyone gets there; the route then faces off the two
// least-voted of the candidates.

/** Share of a pair's candidates drawn from portfolios that still need face-offs. */
export const NEEDY_SHARE = 0.8;

/**
 * Up to `count` distinct candidates from `pool` ([{ url }]): each draw comes
 * from the portfolios not in `settled` (a Set of urls with enough face-offs)
 * with chance `needyShare`, else from the whole pool.
 */
export function drawCandidates(pool, settled, { count = 8, needyShare = NEEDY_SHARE, random = Math.random } = {}) {
  const needy = pool.filter((p) => !settled.has(p.url));
  const picked = new Map();
  const want = Math.min(count, pool.length);
  for (let tries = 0; picked.size < want && tries < count * 25; tries++) {
    const from = needy.length && random() < needyShare ? needy : pool;
    const p = from[Math.floor(random() * from.length)];
    picked.set(p.url, p);
  }
  // A very unlucky run of repeats: fill up in pool order.
  for (const p of pool) {
    if (picked.size >= want) break;
    picked.set(p.url, p);
  }
  return [...picked.values()];
}
