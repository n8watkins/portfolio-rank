// Matchmaking: which sites the AI compares today, and in which order they
// are shown. Owner decisions (2026-11-10):
//
//   - mostly close matches: sites with similar ratings, favouring the ones
//     the system is least sure about (that is where one comparison teaches
//     the most, and how a site climbs step by step)
//   - 1 in 5 pairs random from anywhere, so a site that got much better can
//     be noticed and jump far quickly, and groups don't drift apart
//   - the order shown is random every time and recorded, so position bias
//     can be measured
//   - deterministic given a recorded seed: the same ratings and seed give the
//     same plan, so a day's pairs can be reproduced
//   - settled sites (low sigma) are drawn less: the draw weight is sigma^4
//
// Plus 1 in 20 pairs repeats an earlier pair in the other order, which
// measures how often the judge changes its mind and how much the order
// shown matters.
import { BETA, MAX_PER_SITE_PER_DAY, MIN_DRAW_WEIGHT, NEIGHBOURS, RANDOM_EVERY, REPEAT_EVERY } from "./config.mjs";
import { createRng, randInt, shuffled, weightedIndex } from "./prng.mjs";

/** Same direction-independent key as lib/elo.ts pairKey(). */
export const pairKey = (a, b) => [a, b].sort().join("\n");

/** How informative a match between a and b is: likely close, and unsure. */
export function matchValue(a, b) {
  const spread = 2 * BETA ** 2 + a.sigma ** 2 + b.sigma ** 2;
  const closeness = Math.exp(-((a.mu - b.mu) ** 2) / (2 * spread));
  return closeness * Math.sqrt(a.sigma ** 2 + b.sigma ** 2);
}

// sigma^4: an unsure site (8.33) is drawn about 18 times as often as a
// freshly seeded one (4), which is drawn about 6 times as often as a
// settled one (2.5). With sigma^2 the unsure site was drawn only 4 times as
// often, and a redesigned site waited weeks for its comparisons (simulation).
export const drawWeight = (s) => Math.max(s.sigma ** 4, MIN_DRAW_WEIGHT);

/** The kind of the k-th slot of a day's plan: every 5th random, every 20th a repeat (when there are earlier pairs). */
export function slotKind(k, { randomEvery = RANDOM_EVERY, repeatEvery = REPEAT_EVERY, canRepeat = false } = {}) {
  if (canRepeat && repeatEvery > 0 && k % repeatEvery === repeatEvery - 1) return "repeat";
  if (randomEvery > 0 && k % randomEvery === randomEvery - 1) return "random";
  return "close";
}

/**
 * A day's one-on-one plan.
 *   sites        [{url, mu, sigma}] the pool (listed, comparable sites)
 *   n            how many pairs
 *   seed         recorded with every comparison (comparisons.match_seed)
 *   recent       Set of pair keys compared within the cooldown: not drawn
 *                as close or random matches
 *   past         [{shown: [a, b]}] earlier one-on-one comparisons that can
 *                be repeated (the repeat is shown in the other order)
 * Returns [{shown: [first, second], kind}] (kind: close, random or repeat).
 */
export function planPairs({ sites, n, seed, recent = new Set(), past = [], randomEvery = RANDOM_EVERY, repeatEvery = REPEAT_EVERY, maxPerSite = MAX_PER_SITE_PER_DAY }) {
  const rng = createRng(`pairs:${seed}`);
  const pool = [...sites].sort((a, b) => a.mu - b.mu || (a.url < b.url ? -1 : 1));
  if (pool.length < 2) return [];
  const index = new Map(pool.map((s, i) => [s.url, i]));
  const used = new Map();
  const planned = new Set();
  const plan = [];
  const free = (s) => (used.get(s.url) ?? 0) < maxPerSite;
  const ok = (a, b) => a.url !== b.url && free(a) && free(b) && !planned.has(pairKey(a.url, b.url));
  const take = (first, second, kind) => {
    plan.push({ shown: [first.url, second.url], kind });
    planned.add(pairKey(first.url, second.url));
    used.set(first.url, (used.get(first.url) ?? 0) + 1);
    used.set(second.url, (used.get(second.url) ?? 0) + 1);
  };
  const repeatable = past.filter((p) => Array.isArray(p.shown) && p.shown.length === 2 && index.has(p.shown[0]) && index.has(p.shown[1]));

  for (let k = 0, guard = 0; plan.length < n && guard < n * 20; guard++) {
    const kind = slotKind(k, { randomEvery, repeatEvery, canRepeat: repeatable.length > 0 });
    if (kind === "repeat") {
      const p = repeatable[randInt(rng, repeatable.length)];
      const a = pool[index.get(p.shown[1])];
      const b = pool[index.get(p.shown[0])];
      if (ok(a, b)) {
        take(a, b, "repeat");
        k++;
      } else k++; // an unusable repeat slot is skipped, not retried forever
      continue;
    }
    const weights = pool.map((s) => (free(s) ? drawWeight(s) : 0));
    const ai = weightedIndex(rng, weights);
    if (ai < 0) break;
    const anchor = pool[ai];
    let opponent = null;
    if (kind === "random") {
      for (let tries = 0; tries < 20 && !opponent; tries++) {
        const c = pool[randInt(rng, pool.length)];
        if (ok(anchor, c) && !recent.has(pairKey(anchor.url, c.url))) opponent = c;
      }
    } else {
      const lo = Math.max(0, ai - NEIGHBOURS);
      const hi = Math.min(pool.length - 1, ai + NEIGHBOURS);
      const cands = [];
      for (let i = lo; i <= hi; i++) {
        const c = pool[i];
        if (ok(anchor, c) && !recent.has(pairKey(anchor.url, c.url))) cands.push(c);
      }
      const ci = weightedIndex(rng, cands.map((c) => matchValue(anchor, c)));
      if (ci >= 0) opponent = cands[ci];
    }
    if (!opponent) {
      // No usable opponent for this anchor: draw again (bounded by guard).
      continue;
    }
    if (rng() < 0.5) take(anchor, opponent, kind);
    else take(opponent, anchor, kind);
    k++;
  }
  return plan;
}

/**
 * A day's batched plan: groups of `size` sites ranked in one request. Each
 * group is an unsure anchor plus sites near it by rating; every 5th group
 * swaps one of them for a random site from anywhere. The order shown is
 * shuffled. Returns [{shown: [urls...], kind}].
 */
export function planBatches({ sites, n, size, seed, randomEvery = RANDOM_EVERY, maxPerSite = MAX_PER_SITE_PER_DAY }) {
  const rng = createRng(`batches:${seed}`);
  const pool = [...sites].sort((a, b) => a.mu - b.mu || (a.url < b.url ? -1 : 1));
  if (pool.length < size || size < 2) return [];
  const used = new Map();
  const free = (s) => (used.get(s.url) ?? 0) < maxPerSite;
  const plan = [];
  for (let k = 0, guard = 0; plan.length < n && guard < n * 20; guard++) {
    const ai = weightedIndex(rng, pool.map((s) => (free(s) ? drawWeight(s) : 0)));
    if (ai < 0) break;
    const window = [];
    const reach = Math.max(NEIGHBOURS, size * 2);
    for (let i = Math.max(0, ai - reach); i <= Math.min(pool.length - 1, ai + reach); i++) {
      if (i !== ai && free(pool[i])) window.push(pool[i]);
    }
    if (window.length < size - 1) continue;
    let members = shuffled(rng, window).slice(0, size - 1);
    const kind = randomEvery > 0 && k % randomEvery === randomEvery - 1 ? "random" : "close";
    if (kind === "random") {
      const inGroup = new Set([pool[ai].url, ...members.map((m) => m.url)]);
      const outside = pool.filter((s) => free(s) && !inGroup.has(s.url));
      if (outside.length) members[members.length - 1] = outside[randInt(rng, outside.length)];
    }
    const group = shuffled(rng, [pool[ai], ...members]);
    for (const s of group) used.set(s.url, (used.get(s.url) ?? 0) + 1);
    plan.push({ shown: group.map((s) => s.url), kind });
    k++;
  }
  return plan;
}
