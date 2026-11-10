// The rating system as a whole, on a seeded simulation (lib/ranking/simulate.mjs):
// does it find the hidden truth, keep tiers in order, and let an improved
// site climb? Offline and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recompute } from "../lib/ranking/views.mjs";
import { simulate, spearman } from "../lib/ranking/simulate.mjs";
import { summarize } from "../lib/ranking/report.mjs";

const sites = Array.from({ length: 400 }, (_, i) => ({ url: `https://site${i}.dev` }));
const opts = { sites, days: 28, aiPerDay: 40, batchedPerDay: 20, humansPerDay: 15, seed: "test" };

test("simulation: comparisons improve on the seeds, and the boards track the hidden truth", () => {
  const sim = simulate(opts);
  const seeds = recompute({ ...sim, comparisons: [], resets: [], aiWeight: 0.5, history: false });
  const r = recompute({ ...sim, aiWeight: 0.5 });
  const seedOnly = spearman(seeds.boards.ai, sim.truth);
  assert.ok(seedOnly > 0.7, `seeds alone ${seedOnly}`);
  assert.ok(spearman(r.boards.ai, sim.truth) > seedOnly, "AI comparisons add information");
  assert.ok(spearman(r.boards.merged, sim.truth) > seedOnly, "so does Merged");
  assert.ok(spearman(r.boards.people, sim.truth) > 0.2, "People, from a few random human votes, still point the right way");
  assert.ok(spearman(r.boards.ai_experiment, sim.truth) >= spearman(r.boards.ai, sim.truth) - 0.01, "batched results add information too");
  // The same seed gives the same simulation and the same boards.
  assert.deepEqual(recompute({ ...simulate(opts), aiWeight: 0.5 }).boards.merged, r.boards.merged);
  // The summary has every view and the stability numbers.
  const s = summarize({ ...r, comparisons: sim.comparisons, top: 20 });
  assert.deepEqual(Object.keys(s.views), ["merged", "people", "ai", "ai_experiment"]);
  assert.equal(s.views.merged.top.length, 20);
  const bias = s.stability.positionBias.find((p) => p.judge.startsWith("ai|"));
  assert.ok(bias.share > 0.5, "the simulated judge's first-shown bias is visible");
  assert.ok(s.stability.movement.merged.weeks.length >= 3);
});

test("simulation: seeding by tier puts every S above every D", () => {
  const sim = simulate({ ...opts, days: 0 });
  const board = recompute({ ...sim, aiWeight: 0.5, history: false }).boards.merged;
  const worstS = Math.max(...board.filter((r) => r.tier === "S").map((r) => r.rank));
  const bestD = Math.min(...board.filter((r) => r.tier === "D").map((r) => r.rank));
  assert.ok(board.some((r) => r.tier === "S") && board.some((r) => r.tier === "D"));
  assert.ok(worstS < bestD, `worst S ${worstS}, best D ${bestD}`);
});

test("simulation: a D site that becomes S quality climbs to the top 10% within 15 comparisons after its page changes", () => {
  const board = recompute({ ...simulate({ ...opts, days: 0 }), aiWeight: 0.5, history: false }).boards.ai;
  const d = board.filter((r) => r.tier === "D");
  const url = d[Math.floor(d.length / 2)].url;
  const improve = { url, day: 7, truth: 2.4 };
  const withReset = simulate({ ...opts, improve });
  const top10 = Math.ceil(sites.length * 0.1);
  const hit = withReset.trajectory.find((t) => t.rank <= top10);
  assert.ok(hit, `never reached the top 10%: ${JSON.stringify(withReset.trajectory.slice(-3))}`);
  assert.ok(hit.comparisons <= 15, `took ${hit.comparisons} comparisons`);
  // Without the reset its low uncertainty keeps it from being picked and from moving.
  const noReset = simulate({ ...opts, improve, reset: false });
  const noHit = noReset.trajectory.find((t) => t.rank <= top10);
  assert.ok(!noHit || noHit.comparisons > hit.comparisons, "the reset is what makes it fast");
  assert.equal(withReset.resets.length, 1);
});
