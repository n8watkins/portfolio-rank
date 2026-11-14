// The share card's text fitting (lib/og-fit.mjs): names wrap before they
// shrink, shrink before they lose words, and are never cut mid-word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitName, friendlyCount, NAME_MIN } from "../lib/og-fit.mjs";

const W = 500;

test("a short name stays on one line, as big as it fits", () => {
  assert.deepEqual(fitName("Jo Kim", W), { lines: ["Jo Kim"], size: 72 });
  const f = fitName("Nathan Watkins", W);
  assert.deepEqual(f.lines, ["Nathan Watkins"]);
  assert.ok(f.size > 60);
});

test("a long name wraps to two lines before it shrinks further, with whole words", () => {
  const f = fitName("Alexandria Catherine Montgomery-Smith", W);
  assert.deepEqual(f.lines, ["Alexandria Catherine", "Montgomery-Smith"]);
  assert.ok(f.size >= NAME_MIN);
});

test("too long for two lines: the middle names go first, never a cut word", () => {
  const f = fitName("Maximiliana Alexandrovna Ekaterina Konstantinopoulou", W);
  assert.deepEqual(f.lines, ["Maximiliana", "Konstantinopoulou"]);
  // A surname too long even alone: trailing words go instead, whole.
  const g = fitName("Maximiliana Alexandrovna Ekaterina Konstantinopoulou-Featherstonehaughwright", W);
  const words = "Maximiliana Alexandrovna Ekaterina".split(" ");
  assert.deepEqual(g.lines.join(" ").split(" "), words.slice(0, g.lines.join(" ").split(" ").length));
  for (const line of g.lines) assert.doesNotMatch(line, /…/);
});

test("one impossible word is the only thing ever cut, with an ellipsis", () => {
  const f = fitName("A".repeat(80), W);
  assert.equal(f.size, NAME_MIN);
  assert.match(f.lines.at(-1), /…$/);
});

test("friendly counts round down and say +", () => {
  assert.equal(friendlyCount(1370), "1,300+");
  assert.equal(friendlyCount(2000), "2,000");
  assert.equal(friendlyCount(2046), "2,000+");
  assert.equal(friendlyCount(87), "87");
  assert.equal(friendlyCount(187), "180+");
});
