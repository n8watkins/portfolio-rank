// Draws the fixed-seed sample of 100 sites from local/all.json.
// Writes sample.json (committed): url, group, model, shot_key.
// Usage: node experiments/junk-detection/sample.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 20261113;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function pick(list, n) {
  const a = [...list].sort((x, y) => (x.url < y.url ? -1 : 1));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const rows = JSON.parse(readFileSync(join(here, "local/all.json"), "utf8"));
const isP = (r) => (r.ai_rubric && typeof r.ai_rubric === "object" ? r.ai_rubric.is_portfolio : undefined);
const model = (r) => (r.ai_rubric && typeof r.ai_rubric === "object" ? r.ai_rubric.model ?? null : null);
const no = (r) => isP(r) === false || isP(r) === 0;
const yes = (r) => isP(r) === true || isP(r) === 1;

const not31 = rows.filter((r) => no(r) && model(r) === "gemini-3.1-flash-lite");
const not35 = rows.filter((r) => no(r) && model(r) === "gemini-3.5-flash-lite");
const delisted = rows.filter((r) => r.delisted_at && yes(r));
// Ranked: what the app lists (delisted_at null, not hidden) and graded a portfolio.
const ranked = rows.filter((r) => !r.delisted_at && r.status === "live" && r.health !== "down" && yes(r));

const sample = [
  ...pick(not31, 20).map((r) => ({ group: "not_portfolio", r })),
  ...pick(not35, 20).map((r) => ({ group: "not_portfolio", r })),
  ...pick(delisted, 20).map((r) => ({ group: "delisted", r })),
  ...pick(ranked, 40).map((r) => ({ group: "ranked", r })),
].map(({ group, r }, i) => ({ id: i + 1, url: r.url, group, model: model(r), shot_key: r.shot_key, has_text: Boolean(r.page_text) }));

writeFileSync(join(here, "sample.json"), JSON.stringify(sample, null, 1) + "\n");
console.log(`pools: not31=${not31.length} not35=${not35.length} delisted=${delisted.length} ranked=${ranked.length}; sample=${sample.length}`);
