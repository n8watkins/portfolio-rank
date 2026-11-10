// A small seeded random number generator, so a day's matchmaking can be
// reproduced exactly from its recorded seed (comparisons.match_seed).
// cyrb53 turns the seed string into a number; mulberry32 generates from it.
// Both are public-domain, well-known and tiny; this is not for cryptography.

/** 53-bit hash of a string (cyrb53). */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A function returning floats in [0, 1), the same sequence for the same seed. */
export function createRng(seed) {
  let a = hashString(String(seed)) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [0, n). */
export const randInt = (rng, n) => Math.floor(rng() * n);

/** Index drawn with probability proportional to weights[i] (all >= 0, at least one > 0). */
export function weightedIndex(rng, weights) {
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** A shuffled copy (Fisher-Yates). */
export function shuffled(rng, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A normal deviate (Box-Muller), for simulations. */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
