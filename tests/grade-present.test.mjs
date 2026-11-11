// lib/grader/present.mjs: how the grade report page words a grade (no server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CELEBRATIONS, FACT_COPY, FACT_GROUPS, celebrationLevel, fixEffects, hiringGroups, placeIn, verdictOf } from "../lib/grader/present.mjs";
import { BADGES } from "../lib/games/badges.mjs";

test("celebrations: an S is level 5 whatever its place; otherwise the top 50, 25, 10 and 5% bands; each badge exists", () => {
  assert.equal(celebrationLevel(null), 0);
  assert.equal(celebrationLevel({ tier: "S", percentile: null }), 5);
  assert.equal(celebrationLevel({ tier: "s", percentile: { topPct: 30 } }), 5);
  const at = (topPct) => celebrationLevel({ tier: "A", percentile: { topPct } });
  assert.deepEqual([1, 5, 6, 10, 11, 25, 26, 50, 51, 100].map(at), [4, 4, 3, 3, 2, 2, 1, 1, 0, 0]);
  assert.equal(celebrationLevel({ tier: "B", percentile: null }), 0);
  for (const c of CELEBRATIONS.filter(Boolean)) {
    assert.equal(CELEBRATIONS[c.level], c);
    if (c.badge) assert.equal(BADGES.find((b) => b.id === c.badge)?.target, c.level, c.badge);
  }
});
import { factLines, strengthsAndFixes } from "../lib/grader/report.mjs";
import { CODE_CRITERIA } from "../pipeline/rubric.mjs";
import { seedFromGrade } from "../lib/ranking/engine.mjs";

const axis = (score, note = "") => ({ score, note });
const grade = (over = {}) => ({
  tier: "B",
  rubric_version: 2,
  model: "gemini-3.5-flash-lite",
  visual_design: axis(4, "Clean."),
  five_second_test: axis(4),
  storytelling: axis(2, "Projects say what, not why."),
  writing: axis(3),
  memorability: axis(3),
  checks: { resume: false, github: true, contact: true, project_links: true, own_domain: true, fresh_footer: true, original: true },
  facts: { footer_year: 2026, project_links: { checked: 3, ok: 3, broken: 0 } },
  ...over,
});
grade.withQuality = (g) => ({ ...g, quality_score: 3.25 });

test("every weighted code check has hiring-manager copy and sits in exactly one group", () => {
  const ids = CODE_CRITERIA.filter((c) => c.weight > 0).map((c) => c.id);
  const grouped = FACT_GROUPS.flatMap((g) => g.facts);
  assert.deepEqual([...grouped].sort(), [...ids].sort());
  for (const id of ids) assert.ok(FACT_COPY[id]?.short && FACT_COPY[id]?.missing && FACT_COPY[id]?.fix, id);
});

test("facts become three questions: chips for what passes, cards for what's missing, unmeasured apart", () => {
  const facts = factLines({ ...grade(), checks: { ...grade().checks, original: null } });
  const groups = hiringGroups(facts);
  assert.deepEqual(groups.map((g) => g.title), ["Can they reach you?", "Can they see your work?", "Does it look current and yours?"]);
  const reach = groups[0];
  assert.deepEqual(reach.ok.map((f) => f.short), ["Contact"]);
  assert.equal(reach.missing.length, 1);
  assert.equal(reach.missing[0].short, "Resume");
  assert.match(reach.missing[0].fix, /PDF/);
  assert.equal(groups[1].missing.length, 0);
  assert.deepEqual(groups[2].unknown.map((f) => f.id), ["original"]);
  assert.deepEqual(hiringGroups([]), [], "nothing measured, nothing shown");
});

test("a fix says what it changes: places gained for an AI axis, the checks score for a fact", () => {
  const g = grade.withQuality(grade());
  const me = seedFromGrade(g).mu;
  // Ten listed portfolios just above this one, ten far above, ten below.
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://near${i}.dev`, mu: me + 0.01 + i * 0.001 })),
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://far${i}.dev`, mu: me + 9 })),
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://below${i}.dev`, mu: me - 1 })),
    { url: "https://self.dev", mu: me + 0.02 },
  ];
  const { fixes } = strengthsAndFixes(g);
  const out = fixEffects(g, fixes, pool, { isSelf: (u) => u === "https://self.dev" });
  const story = out.find((f) => f.criterion === "storytelling");
  assert.match(story.effect, /^about 10 places higher if project presentation goes up one point$/i);
  const resume = out.find((f) => f.criterion === "resume");
  assert.match(resume.effect, /^checks passed go from \d+ to 100 of 100$/);
  // An empty pool still says something true.
  assert.match(fixEffects(g, fixes, []).find((f) => f.criterion === "storytelling").effect, /quality score goes from 3\.3 to 3\.5 of 5/);
});

test("verdicts by tier, and a pool site's place", () => {
  assert.match(verdictOf("S"), /One of the best/);
  assert.equal(verdictOf("Z"), verdictOf("C"));
  const pool = [
    { url: "a", mu: 30 },
    { url: "b", mu: 25 },
    { url: "c", mu: 20 },
    { url: "d", mu: 10 },
  ];
  assert.deepEqual(placeIn(pool, "b"), { rank: 2, total: 4, topPct: 50 });
  assert.equal(placeIn(pool, "zzz"), null);
});
