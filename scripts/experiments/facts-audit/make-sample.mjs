#!/usr/bin/env node
// The facts audit's sample (2026-11-21): the 25 sites picked by hand from
// the review queue and the newest captures (pick25.json, passed as the first
// argument), plus RANDOM_COUNT sites drawn from data/feed.json with a fixed
// seed, so the same list comes out every time. Writes sample.json next to
// this file.
//
//   node scripts/experiments/facts-audit/make-sample.mjs <pick25.json>
import fs from "node:fs";
import path from "node:path";

const SEED = 20261121;
const RANDOM_COUNT = 45;
const here = import.meta.dirname;
const root = path.join(here, "..", "..", "..");

// mulberry32: a small seeded generator, enough for a reproducible draw.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const picked = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).map((r) => ({ url: r.url, name: r.name, from: "pick25" }));
const feed = JSON.parse(fs.readFileSync(path.join(root, "data", "feed.json"), "utf8"));
const taken = new Set(picked.map((p) => p.url));
const pool = feed.filter((f) => f.url && !taken.has(f.url));
const rand = rng(SEED);
// Fisher-Yates over the pool, then the first RANDOM_COUNT.
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const random = pool.slice(0, RANDOM_COUNT).map((f) => ({ url: f.url, name: f.name, from: `feed seed ${SEED}` }));
const sample = [...picked, ...random];
fs.writeFileSync(path.join(here, "sample.json"), `${JSON.stringify(sample, null, 2)}\n`);
console.log(`${sample.length} sites (${picked.length} picked, ${random.length} random) -> sample.json`);
