// recheck-543 (scripts/experiments/recheck-543*.mjs): the groups, the plan
// (batches of 5 with the last one filled up, 20 per group alone) and each
// decision path. Pure; no browser, no database, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, groupOf, makePlan, pilotPlan, shardCount, shotKeyOf } from "../scripts/experiments/recheck-543.mjs";
import { changeFor, decide, queueRow } from "../scripts/experiments/recheck-543-analyze.mjs";
import { buildDupIndex } from "../pipeline/junk-rules.mjs";

test("groups: graded not-a-portfolio first, then delisted, broken and live", () => {
  assert.equal(groupOf({ graded: 1, not_portfolio: 1, delisted_at: "2026-11-10" }), "not_portfolio");
  assert.equal(groupOf({ graded: 1, delisted_at: "2026-11-10" }), "delisted_graded");
  assert.equal(groupOf({ graded: 0, delisted_at: "2026-11-10" }), "delisted_ungraded");
  assert.equal(groupOf({ graded: 0, hidden: 1 }), "broken");
  assert.equal(groupOf({ graded: 0 }), "live_ungraded");
  assert.equal(groupOf({ graded: 1 }), null, "a graded portfolio not in membership is in no group");
  assert.match(shotKeyOf("https://a.dev"), /^[0-9a-f]{16}$/);
});

test("plan: every site batched once (the last batch filled from the first), 20 per group alone, deterministic", () => {
  const sites = [];
  for (const [gi, g] of GROUPS.entries()) for (let i = 0; i < 25; i++) sites.push({ id: `X${gi}${String(i).padStart(2, "0")}`, group: g });
  const ids = sites.map((s) => s.id).slice(0, 123);
  const plan = makePlan(sites, ids);
  const batches = plan.requests.filter((r) => r.kind === "batch");
  assert.equal(batches.length, Math.ceil(123 / 5));
  assert.ok(batches.every((b) => b.ids.length === 5 && new Set(b.ids).size === 5));
  const counted = batches.flatMap((b) => b.ids.filter((id) => !b.pad.includes(id)));
  assert.deepEqual([...counted].sort(), [...ids].sort(), "each site answered once, padding aside");
  const solo = plan.requests.filter((r) => r.kind === "solo").map((r) => r.ids[0]);
  assert.equal(new Set(solo).size, solo.length);
  assert.deepEqual(JSON.stringify(makePlan(sites, ids)), JSON.stringify(plan));
});

const answer = (p) => ({ is_portfolio: { answer: p, reason: "r" }, visual_design: { score: 3 }, project_presentation: { score: 3 }, writing: { score: 3 } });
const meta = (extra = {}) => ({ signals: { score: 2, projects: true }, page_text: "Jane builds payment systems. ".repeat(5), gate: {}, modal: {}, mode_pick: {}, ...extra });
const site = (group) => ({ id: "X001", url: "https://jane.dev", name: "Jane", group, current: group === "live_ungraded" ? "listed" : "delisted", off_list: group.startsWith("delisted"), shot_key: "0123456789abcdef" });

test("decisions: failed, blocked, code rule, copy, agreement and disagreement", () => {
  const dupIndex = new Map();
  assert.equal(decide(site("broken"), meta({ failed: "timeout" }), { dupIndex }).path, "capture_failed");
  const blocked = decide(site("not_portfolio"), meta({ blocked: "12 words and no outbound links" }), { g: answer(true), h: answer(true), dupIndex });
  assert.deepEqual([blocked.path, blocked.proposed, blocked.agreed], ["capture_blocked", "review", false]);
  const junk = decide(site("live_ungraded"), meta({ page_text: "Hi, I'm John Doe" }), { dupIndex });
  assert.deepEqual([junk.path, junk.proposed], ["code_rule", "remove"]);
  // Templates are fine: promo text next to the person's own work is graded normally.
  assert.equal(decide(site("live_ungraded"), meta({ page_text: "Build your AI portfolio. My projects: Ledger" }), { g: answer(true), h: answer(true), dupIndex }).path, "graders");
  const agree = decide(site("delisted_graded"), meta(), { g: answer(true), h: answer(true), dupIndex });
  assert.deepEqual([agree.outcome, agree.proposed, agree.agreed], ["portfolio", "relist", true]);
  const keep = decide(site("not_portfolio"), meta(), { g: answer(false), h: answer(false), dupIndex });
  assert.deepEqual([keep.outcome, keep.proposed], ["not_portfolio", null], "already out and both say so: no change");
  const split = decide(site("not_portfolio"), meta(), { g: answer(true), h: answer(false), dupIndex });
  assert.deepEqual([split.outcome, split.proposed, split.agreed], ["disagree", "relist", false]);
  // The guard: strong signals turn a "not a portfolio" into a portfolio for that grader.
  const guarded = decide(site("not_portfolio"), meta({ signals: { score: 5, projects: true } }), { g: answer(false), h: answer(true), dupIndex });
  assert.deepEqual([guarded.outcome, guarded.proposed, guarded.agreed], ["portfolio", "relist", true]);
  assert.equal(decide(site("not_portfolio"), meta(), { g: answer(true), dupIndex }).outcome, "pending");
});

test("two 'no' answers stand: the guard never overrides both models, and a shared 404 page is not a copy", () => {
  // techfolios.github.io's kind: a template tool's site with a name, a projects word and a contact link (signals 4+).
  const strong = meta({ signals: { score: 6, projects: true } });
  const both = decide(site("not_portfolio"), strong, { g: answer(false), h: answer(false), dupIndex: new Map() });
  assert.deepEqual([both.outcome, both.proposed, both.agreed], ["not_portfolio", null, true]);
  // Identical GitHub "Site not found" text on many hosts: dead, not a copy, when both models say so.
  const text = "404 There isn't a GitHub Pages site here. If you're trying to publish one, read the full documentation to learn how to set up GitHub Pages for your repository.";
  const idx = buildDupIndex([{ url: "https://other.github.io", page_text: text }]);
  const dead = decide(site("delisted_graded"), meta({ page_text: text }), { g: answer(false), h: answer(false), dupIndex: idx });
  assert.deepEqual([dead.path, dead.outcome], ["graders", "not_portfolio"]);
  // The same text with a model saying portfolio is a possible copy: a person decides.
  const copy = decide(site("delisted_graded"), meta({ page_text: text }), { g: answer(true), h: answer(false), dupIndex: idx });
  assert.equal(copy.path, "same_text");
});

test("changes and queue rows: only what would change, with the capture note", () => {
  assert.equal(changeFor({ group: "live_ungraded" }, true), null);
  assert.equal(changeFor({ group: "live_ungraded" }, false), "remove");
  assert.equal(changeFor({ group: "broken" }, true), "relist");
  const d = decide(site("delisted_graded"), meta({ modal: { desktop: { button: "Continue", how: ["button"], passed: true } } }), { g: answer(true), h: answer(true), dupIndex: new Map() });
  const row = queueRow(d, { gemini31: {}, haiku: {} });
  assert.equal(row.off_list, 1);
  assert.equal(row.agreed, 1);
  assert.equal(JSON.parse(row.signals).capture.action, 'clicked "Continue"');
  assert.equal(queueRow({ ...d, proposed: null }, {}), null);
});

test("v2.1: code never says 'not a portfolio' for a missing sign, a missing role included", () => {
  // abhisheksharma.codes's kind: a name and a Projects button, no role anywhere.
  const noRole = meta({ signals: { score: 2, name: true, projects: true }, page_text: "Abhishek Sharma. Projects. Contact. Selected work below." });
  const d = decide(site("delisted_ungraded"), noRole, { dupIndex: new Map() });
  assert.notEqual(d.path, "code_rule");
  assert.equal(d.outcome, "pending", "it waits for the graders; nothing in code decides it");
  // Even with no signs at all, only an exclusion rule says no.
  const bare = decide(site("live_ungraded"), meta({ signals: { score: 0 }, page_text: "Hello there, welcome to my corner of the web where I share things." }), { dupIndex: new Map() });
  assert.notEqual(bare.path, "code_rule");
});

test("pilot plans are whole batches of 5; capture machines follow the site count", () => {
  const p = pilotPlan(["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"]);
  assert.deepEqual(p.requests.map((r) => r.ids.length), [5, 5]);
  assert.throws(() => pilotPlan(["X1", "X2", "X3"]), /multiple of 5/);
  assert.deepEqual([9, 10, 32, 199, 543].map(shardCount), [1, 1, 3, 19, 20]);
});
