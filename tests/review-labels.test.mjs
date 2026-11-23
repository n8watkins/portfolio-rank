// The review queue's two buttons say what happens to the site, from one place
// (components/admin/review-labels.ts): owner, 2026-11-23, "reject is unclear as
// the opposite. It should be like, take off the list, keep on the list". Every
// kind of row the queue shows, its two labels, their questions, the line
// beside them, and the Decided list's words; never "Reject".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS } from "../lib/reviews/store.mjs";
import { decidedLabel, declineOf, declinedEffect, hintOf, outcomeOf } from "../components/admin/review-labels.ts";

const row = (proposed, group, current) => ({ proposed, group, current });

test("a removal row: Take off the list or Keep on the list, and the line says what each does", () => {
  for (const r of [row("remove", "door_not_portfolio", "ranked"), row("remove", "signals_collapsed", "ranked"), row("remove", "door_held", "ranked"), row("remove", "not_portfolio", "listed")]) {
    assert.equal(outcomeOf(r).label, "Take off the list");
    const d = declineOf(r);
    assert.deepEqual([d.label, d.question, d.done], ["Keep on the list", "Confirm: keep this site on the list?", "Kept on the list"]);
    assert.equal(hintOf(r), "Take off the list: off the list at once. Keep on the list: stays listed, and no rule removes it again.");
  }
  // A removal proposed for a site that is not listed now: nothing is claimed about it being listed.
  assert.equal(declineOf(row("remove", "not_portfolio", "hidden")).does, "stays as it is, and no rule removes it.");
});

test("a bring-back row: Bring back or Leave it off, with the real timing of each case", () => {
  const cases = [
    [row("relist", "not_portfolio", "listed"), "Bring back: back in the rankings at once. Leave it off: stays as it is."],
    [row("relist", "delisted_graded", "delisted"), "Bring back: back on the list after the next daily sync. Leave it off: stays off the list."],
    [row("relist", "delisted_ungraded", "delisted"), "Bring back: back on the list after the next daily sync. It is ranked after its first nightly grade. Leave it off: stays off the list."],
    [row("relist", "broken", "hidden"), "Bring back: shows again after its next capture. It is ranked after its first nightly grade. Leave it off: stays hidden."],
    [row("relist", "live_ungraded", "listed"), "Bring back: ranked after its first nightly grade. Leave it off: stays as it is."],
  ];
  for (const [r, hint] of cases) {
    assert.equal(outcomeOf(r).label, "Bring back");
    const d = declineOf(r);
    assert.deepEqual([d.label, d.question, d.done], ["Leave it off", "Confirm: leave this site off?", "Left off"]);
    assert.equal(hintOf(r), hint);
  }
});

test("a check-only row: Mark checked or Dismiss; neither changes the site", () => {
  for (const group of ["bot_wall", "recapture_blocked"]) {
    const r = row("review", group, "hidden");
    assert.equal(outcomeOf(r).label, "Mark checked");
    assert.deepEqual([declineOf(r).label, declineOf(r).question, declineOf(r).done], ["Dismiss", "Confirm: dismiss?", "Dismissed"]);
    assert.equal(hintOf(r), "Mark checked: you looked. Dismiss: not worth a look. Neither changes the site.");
  }
});

test("the Decided list uses the same words", () => {
  const decided = (proposed, status) => decidedLabel({ ...row(proposed, "x", "listed"), status });
  assert.equal(decided("remove", "rejected"), "Kept on the list");
  assert.equal(decided("relist", "rejected"), "Left off");
  assert.equal(decided("review", "rejected"), "Dismissed");
  assert.equal(decided("remove", "confirmed"), "Confirmed");
  assert.equal(decided("review", "confirmed"), "Checked");
  assert.equal(decided("relist", "closed"), "Closed");
  assert.equal(declinedEffect(row("remove", "door_held", "ranked"), true), "Stays listed; the grade records your decision.");
  assert.equal(declinedEffect(row("remove", "door_held", "ranked"), false), "Nothing changed on the site.");
  assert.equal(declinedEffect(row("relist", "not_portfolio", "listed"), false), "Nothing changed on the site.");
});

test("every group the queue knows has both buttons in words, and no review page file says Reject", () => {
  for (const group of Object.keys(GROUPS)) {
    for (const proposed of ["remove", "relist", "review"]) {
      const r = row(proposed, group, "listed");
      assert.ok(declineOf(r).label && !/reject/i.test(declineOf(r).label + hintOf(r)), `${group} ${proposed}`);
    }
  }
  for (const f of ["components/admin/StatusReviewQueue.tsx", "components/admin/ShotViewer.tsx", "components/admin/review-labels.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""), /"Reject|Rejected|Rejecting|REJECT_QUESTION/, f);
  }
});
