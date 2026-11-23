// Splits the benchmark's labelled sites once into a design half and a
// held-out half, balanced by label, kind and whether the code left the site
// listed. Writes split.json. Run once; the seed is recorded in the file.
//
//   node experiments/two-model-check/split.mjs
import fs from "node:fs";
import path from "node:path";
import { BENCH_FILE, OUT_DIR, HERE, mulberry32 } from "./common.mjs";

const SEED = 20261124;

const bench = JSON.parse(fs.readFileSync(BENCH_FILE, "utf8"));
const rand = mulberry32(SEED);
const listed = (o) => ["keep", "flag", "unknown"].includes(o);
const strata = new Map();
for (const s of bench.sites) {
  if (s.label.class === "unsure") continue;
  const key = `${s.label.class}|${s.label.kind ?? ""}|${listed(s.outcome) ? "listed" : "hidden"}`;
  if (!strata.has(key)) strata.set(key, []);
  strata.get(key).push(s.url);
}
const design = [];
const heldout = [];
// Odd strata: the spare site goes to whichever half is smaller so far, the
// held-out half on a tie.
for (const key of [...strata.keys()].sort()) {
  const urls = strata.get(key).slice().sort();
  for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }
  const half = Math.floor(urls.length / 2);
  design.push(...urls.slice(0, half));
  heldout.push(...urls.slice(half, 2 * half));
  if (urls.length % 2) (design.length < heldout.length ? design : heldout).push(urls[urls.length - 1]);
}
const out = {
  seed: SEED,
  made: new Date().toISOString(),
  how: "Stratified by label class, kind and whether the code left the site listed (keep, flag) or not; each stratum shuffled with mulberry32(seed) and halved. The 3 unsure sites are left out.",
  strata: Object.fromEntries([...strata].map(([k, v]) => [k, { total: v.length, design: v.filter((u) => design.includes(u)).length, heldout: v.filter((u) => heldout.includes(u)).length }])),
  design: design.sort(),
  heldout: heldout.sort(),
};
for (const dir of [HERE, OUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "split.json");
  if (fs.existsSync(file)) {
    console.error(`${file} exists; the split is made once. Delete it by hand only to start the experiment over.`);
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
}
console.log(`design ${design.length}, held-out ${heldout.length}`);
console.log(out.strata);
