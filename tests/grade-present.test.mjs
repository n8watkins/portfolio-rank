// lib/grader/present.mjs: how the grade report page words a grade (no server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CELEBRATIONS, FACT_COPY, FACT_GROUPS, celebrationLevel, fixEffects, hiringGroups, placeIn, verdictOf } from "../lib/grader/present.mjs";
import { BADGES } from "../lib/games/badges.mjs";

test("celebrations: an SSS is level 5 whatever its place; otherwise the top 50, 25, 10 and 5% bands; each badge exists", () => {
  assert.equal(celebrationLevel(null), 0);
  assert.equal(celebrationLevel({ tier: "SSS", percentile: null }), 5);
  assert.equal(celebrationLevel({ tier: "sss", percentile: { topPct: 30 } }), 5);
  // A plain S (the top 10%, tiers by rank) is celebrated by its place.
  assert.equal(celebrationLevel({ tier: "S", percentile: { topPct: 8 } }), 3);
  const at = (topPct) => celebrationLevel({ tier: "A", percentile: { topPct } });
  assert.deepEqual([1, 5, 6, 10, 11, 25, 26, 50, 51, 100].map(at), [4, 4, 3, 3, 2, 2, 1, 1, 0, 0]);
  assert.equal(celebrationLevel({ tier: "B", percentile: null }), 0);
  for (const c of CELEBRATIONS.filter(Boolean)) {
    assert.equal(CELEBRATIONS[c.level], c);
    if (c.badge) assert.equal(BADGES.find((b) => b.id === c.badge)?.target, c.level, c.badge);
  }
});
import { factLines, strengthsAndFixes } from "../lib/grader/report.mjs";
import { CODE_CRITERIA, NOT_A_FAULT } from "../pipeline/rubric.mjs";
import { gradeKey } from "../lib/grade-score.mjs";

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
  const ids = CODE_CRITERIA.filter((c) => c.weight > 0 && !NOT_A_FAULT.has(c.id)).map((c) => c.id);
  const grouped = FACT_GROUPS.flatMap((g) => g.facts);
  assert.deepEqual([...grouped].sort(), [...ids].sort());
  for (const id of ids) assert.ok(FACT_COPY[id]?.short && FACT_COPY[id]?.missing && FACT_COPY[id]?.fix, id);
});

test("facts become three questions: chips for what passes, cards for what's missing, unmeasured apart", () => {
  const facts = factLines({ ...grade(), checks: { ...grade().checks, fresh_footer: null } });
  const groups = hiringGroups(facts);
  assert.deepEqual(groups.map((g) => g.title), ["Can they reach you?", "Can they see your work?", "Does it look current?"]);
  const reach = groups[0];
  assert.deepEqual(reach.ok.map((f) => f.short), ["Contact"]);
  assert.equal(reach.missing.length, 1);
  assert.equal(reach.missing[0].short, "Resume");
  assert.match(reach.missing[0].fix, /PDF/);
  assert.equal(groups[1].missing.length, 0);
  assert.deepEqual(groups[2].unknown.map((f) => f.id), ["fresh_footer"]);
  assert.deepEqual(hiringGroups([]), [], "nothing measured, nothing shown");
});

test("a fix says what it changes: places gained for an AI axis, the checks score for a fact", () => {
  const g = grade.withQuality(grade());
  // Places by score (the grade key, lib/grade-score.mjs): ten listed portfolios just above this one, ten far above, ten below.
  const me = gradeKey(g);
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://near${i}.dev`, key: me + 10 + i })),
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://far${i}.dev`, key: me + 90000 })),
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://below${i}.dev`, key: me - 100 })),
    { url: "https://self.dev", key: me + 20 },
  ];
  const { fixes } = strengthsAndFixes(g);
  const out = fixEffects(g, fixes, pool, { isSelf: (u) => u === "https://self.dev" });
  const story = out.find((f) => f.criterion === "storytelling");
  assert.match(story.effect, /^the grade climbs about 10 places if project presentation goes up one point$/i);
  const resume = out.find((f) => f.criterion === "resume");
  assert.match(resume.effect, /^checks passed go from \d+ to 100 of 100$/);
  // An empty pool still says something true.
  assert.match(fixEffects(g, fixes, []).find((f) => f.criterion === "storytelling").effect, /quality score goes from 3\.3 to 3\.5 of 5/);
});

test("verdicts by tier, and a pool site's place", () => {
  assert.match(verdictOf("S"), /One of the best/);
  assert.match(verdictOf("SSS"), /very best/);
  assert.match(verdictOf("S+"), /Outstanding/);
  assert.equal(verdictOf("A-"), verdictOf("A"), "plus and minus share their letter's line");
  assert.equal(verdictOf("Z"), verdictOf("C"));
  // The place by ELO the hourly refresh stored (lib/tiers-store.mjs), not by the grade or the seed level.
  const pool = [
    { url: "a", mu: 10, key: 30, place: 1, of: 4, top: 13 },
    { url: "b", mu: 25, key: 25, place: 2, of: 4, top: 38 },
    { url: "c", mu: 20, key: 20, place: null, of: null, top: null },
  ];
  assert.deepEqual(placeIn(pool, "b"), { rank: 2, total: 4, topPct: 38 });
  assert.equal(placeIn(pool, "c"), null, "too few face-offs, no place");
  assert.equal(placeIn(pool, "zzz"), null);
});

test("a template is not a fault: no fix, no fact line, no checklist row tells anyone to drop it", async () => {
  const templated = { ...grade(), checks: { ...grade().checks, original: false }, facts: { template: "HTML5 UP" } };
  const { fixes } = strengthsAndFixes(templated);
  assert.equal(fixes.some((f) => f.criterion === "original"), false);
  assert.equal(factLines(templated).some((f) => f.id === "original"), false);
  assert.equal(hiringGroups(factLines(templated)).flatMap((g) => [...g.ok, ...g.missing, ...g.unknown]).some((f) => f.id === "original"), false);
  assert.equal(JSON.stringify(fixes).toLowerCase().includes("template"), false);
  const { checklistItems } = await import("../lib/tools/checklist.ts");
  const rows = checklistItems({ finalUrl: "https://ana.dev", checks: { original: false }, facts: { template: "HTML5 UP" } });
  assert.equal(rows.some((r) => r.id === "original" || /template/i.test(`${r.label} ${r.tip} ${r.found}`)), false);
});
