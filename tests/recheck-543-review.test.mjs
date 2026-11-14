// What takes the 61 needs-a-person sites off the owner's list (owner plan,
// 2026-11-13): the duplicate rule (scripts/experiments/recheck-543-dups.mjs)
// and the screenshot check's decisions (recheck-543-analyze.mjs
// screenDecision). Pure; no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKey, isPlatform, pickKeep } from "../scripts/experiments/recheck-543-dups.mjs";
import { screenDecision } from "../scripts/experiments/recheck-543-analyze.mjs";
import { parseScreen } from "../scripts/experiments/recheck-543-screen.mjs";

test("duplicates: the redirect target, then a custom domain, then the live list, then the shortest", () => {
  // sak03.github.io/sartaj.dev redirects to sartajalam.in.
  assert.equal(pickKeep([{ url: "https://sak03.github.io/sartaj.dev", final: "https://sartajalam.in/" }, { url: "https://sartajalam.in/", final: "https://sartajalam.in/" }]).keep.url, "https://sartajalam.in/");
  // A redirect to the same address with a slash or "www." is not a redirect: pavithran26.net wins as a custom domain.
  const p = pickKeep([
    { url: "https://pavithran26.net", final: "https://www.pavithran26.net/" },
    { url: "https://pavithran26.vercel.app", final: "https://pavithran26.vercel.app/" },
    { url: "https://pavithran26.vercel.app/", final: "https://pavithran26.vercel.app/" },
  ]);
  assert.deepEqual([p.keep.url, p.why], ["https://pavithran26.net", "its own domain, not a platform address"]);
  // The same address spelled two ways: the one on the live list.
  assert.equal(pickKeep([{ url: "https://bruno-simon.com/" }, { url: "https://bruno-simon.com", onFeed: true }]).keep.url, "https://bruno-simon.com");
  assert.equal(addressKey("https://www.Example.dev/"), addressKey("http://example.dev"));
  assert.equal(isPlatform("https://x.vercel.app"), true);
  assert.equal(isPlatform("https://x.dev"), false);
});

const site = (group) => ({ group });
const a = (cls, confidence = "high", click = "") => ({ class: cls, confidence, click, reason: "r" });

test("screenshot check: only what can't be called goes to the owner", () => {
  // High-confidence portfolio, Gemini agrees: the normal flow (relist an out site).
  assert.deepEqual(Object.values((({ path, proposed, agreed }) => ({ path, proposed, agreed }))(screenDecision(site("broken"), a("portfolio"), a("portfolio")))), ["screen", "relist", true]);
  // Gemini still to run: waits, no owner row.
  assert.equal(screenDecision(site("broken"), a("portfolio"), null).outcome, "pending");
  // The models disagree: the owner.
  assert.equal(screenDecision(site("broken"), a("portfolio"), a("blank")).proposed, "review");
  // Blank or loading (high), any bot check, a gate with a visible click: retry later, not the owner.
  for (const x of [a("blank"), a("loading"), a("bot_check", "low"), a("intro_gate", "high", "Enter")]) assert.equal(screenDecision(site("broken"), x, null).path, "retry_later", x.class);
  // Low confidence, or a gate with nothing to click: the owner.
  assert.equal(screenDecision(site("broken"), a("portfolio", "low"), null).proposed, "review");
  assert.equal(screenDecision(site("broken"), a("intro_gate", "high", ""), null).proposed, "review");
  // No answer yet: no decision (the capture stays in review).
  assert.equal(screenDecision(site("broken"), null, null), null);
});

test("screenshot answers are validated", () => {
  assert.deepEqual(parseScreen({ class: "blank", click: "", confidence: "high", reason: "white page" }), { class: "blank", click: "", confidence: "high", reason: "white page" });
  assert.throws(() => parseScreen({ class: "maybe", confidence: "high" }), /class/);
  assert.throws(() => parseScreen({ class: "blank", confidence: "sure" }), /confidence/);
});
