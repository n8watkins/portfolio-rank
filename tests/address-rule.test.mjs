// The address rule (pipeline/junk-rules.mjs urlNotPortfolio: a code host, a
// link-in-bio page, an admin or login path) runs for every address, through
// the Removal rule and its ladder as they are (lib/reviews/door.mjs,
// lib/reviews/store.mjs). Owner, 2026-11-23: "Someone's GitHub is not a
// portfolio page." Before this, the rule ran only when Gemini said "not a
// portfolio", so github.com/ThiagoSousa81, which Gemini graded a portfolio,
// was listed (#280 excluded it by hand).
//   at the door   every grade, whatever Gemini answered
//   the roster    the night's free part (syncReviewRows), for every listed
//                 address, graded or not: an address a person or an earlier
//                 grade argued for waits for the owner; any other gets the
//                 door's removal row, which the hourly rule applies
// Offline: a throwaway database and a mocked Gemini (tests/helpers/door-night.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_RULE_ACTOR, DOOR_RULE_ACTOR, autoApplyReviews, decideReviews, ensureReviewSchema, undoReviews } from "../lib/reviews/store.mjs";
import { doorDecision, syncReviewRows } from "../lib/reviews/door.mjs";
import { DAY, T0, answer, col, context, drive, freshDb, grade, hidden, notPortfolio, reviewsOf, signals, site } from "./helpers/door-night.mjs";

const PROFILE = "https://github.com/someone-dev";

test("at the door: Gemini calls a bare GitHub profile a portfolio, and the address rule still removes it, with Undo", async () => {
  const { db } = await freshDb();
  await site(db, PROFILE, { n: 5 });
  const { ctx, clock } = context(db, { gemini: { [PROFILE]: answer(true) } });
  await drive(ctx, clock);

  const rows = await reviewsOf(db, PROFILE);
  const applied = rows.filter((r) => String(r.status) === "auto_applied");
  assert.equal(applied.length, 1, JSON.stringify(rows.map((r) => [r.status, r.grp, r.decided_by])));
  const [row] = applied;
  assert.equal(String(row.grp), "door_not_portfolio");
  assert.equal(String(row.decided_by), ADDRESS_RULE_ACTOR, "the address rule's own name, never Gemini's");
  assert.match(String(row.reason), /Gemini said this is a portfolio, but its address is not a portfolio page/);
  const sig = JSON.parse(String(row.signals));
  assert.equal(sig.junk_rule, "not a portfolio address");
  assert.equal(sig.door.address, true);
  assert.equal(JSON.parse(String(row.verdicts)).gemini35.solo.is_portfolio, true, "Gemini's own answer, as it gave it");
  // Removed through the same path as any door removal: hidden at once, out of tiers and boards.
  assert.equal(await hidden(db, PROFILE), true);
  assert.equal(await notPortfolio(db, PROFILE), true);
  const g = await grade(db, PROFILE);
  assert.equal(g.is_portfolio, false);
  assert.equal(g.ai_is_portfolio, true, "the grade keeps what Gemini said");

  // Undo: listed again, the row waits for the owner, and the rule never removes it again.
  const [undo] = await undoReviews(db, { ids: [Number(row.id)], actor: "admin:owner", now: new Date(clock.t + 3600000) });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(await hidden(db, PROFILE), false);
  assert.deepEqual(await autoApplyReviews(db, { onFeed: () => true, now: new Date(clock.t + 2 * 3600000) }), []);
  const again = await syncReviewRows(db, { now: new Date(clock.t + DAY) });
  assert.deepEqual(again.address, [], "the owner took it back: the roster pass leaves it alone");
});

test("at the door: the decision for Gemini's 'yes' on a code host follows the ladder (owner first, earlier grades held for him)", () => {
  const row = { url: PROFILE, name: "someone", page_text: "", facts: JSON.stringify({ signals: signals(6) }) };
  const yes = answer(true);
  assert.equal(doorDecision({ grade: yes, row: { ...row, url: "https://someone.github.io/" } }).outcome, "portfolio", "a site on GitHub Pages is a real site");
  const d = doorDecision({ grade: yes, row });
  assert.deepEqual([d.outcome, d.auto, d.address], ["remove", true, true]);
  assert.equal(d.grade.ai_is_portfolio, true);
  assert.equal(doorDecision({ grade: yes, row, owner: { isPortfolio: true, by: "admin:owner", at: "2026-11-20", reason: null, batch: "b" } }).outcome, "owner");
  const previous = { ...answer(true), judged_at: "2026-11-10T00:00:00Z" };
  const held = doorDecision({ grade: yes, row, previous });
  assert.deepEqual([held.outcome, held.group, held.auto], ["held", "door_held", false], "an earlier grade said portfolio: the owner decides");
  assert.equal(doorDecision({ grade: yes, row, takenBack: true }).outcome, "held");
  // A Gemini "no" with the address rule is the door's ordinary junk-rule removal, unchanged.
  const no = doorDecision({ grade: answer(false), row });
  assert.deepEqual([no.outcome, no.address ?? false], ["remove", false]);
});

test("the roster: every listed address the rule catches goes through the Removal rule; real sites and settled cases are left alone", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const now = new Date(T0);
  // Listed, never graded (grading paused): the door's removal row, applied by the hourly rule.
  await site(db, "https://github.com/never-graded", { n: 4 });
  await site(db, "https://linktr.ee/someone", { n: 1, captured: false, status: "error" });
  // Graded a portfolio before: waits for the owner, nothing removed.
  await site(db, "https://github.com/graded-yes", { n: 5, rubric: { ...answer(true), judged_at: "2026-11-10T00:00:00Z" } });
  // Real sites, an owner's keep and a delisted row: no row.
  await site(db, "https://someone.github.io/", { n: 5 });
  await site(db, "https://ann-lee.dev/", { n: 5 });
  await site(db, "https://github.com/kept-by-owner", { n: 5 });
  await site(db, "https://github.com/delisted", { n: 5 });
  await db.execute("UPDATE portfolios SET delisted_at = '2026-11-01' WHERE url = 'https://github.com/delisted'");
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, status, created_at, decided_at, decided_by)
          VALUES ('old', 'https://github.com/kept-by-owner', 'door_not_portfolio', 'ranked', 'remove', 0, 'r', 0, '{}', '{}', 'rejected', '2026-11-01', '2026-11-02', 'admin:owner')`,
  });

  const sent = await syncReviewRows(db, { now });
  assert.deepEqual(sent.address.sort(), ["https://github.com/graded-yes", "https://github.com/never-graded", "https://linktr.ee/someone"]);
  const [held] = await reviewsOf(db, "https://github.com/graded-yes");
  assert.deepEqual([String(held.grp), String(held.status), JSON.parse(String(held.signals)).door.auto], ["door_held", "pending", false]);
  for (const u of ["https://someone.github.io/", "https://ann-lee.dev/", "https://github.com/delisted"]) assert.deepEqual(await reviewsOf(db, u), [], u);
  assert.equal((await reviewsOf(db, "https://github.com/kept-by-owner")).length, 1, "no new row over the owner's keep");
  // Nothing removed by the pass itself: the removal is the hourly rule's, as for any waiting door row.
  assert.equal(await hidden(db, "https://github.com/never-graded"), false);
  // Once a night: the next pass writes nothing new.
  assert.deepEqual((await syncReviewRows(db, { now: new Date(T0 + DAY) })).address, []);

  const applied = await autoApplyReviews(db, { onFeed: () => true, now: new Date(T0 + 3600000) });
  assert.deepEqual(applied.map((a) => [a.url, a.ok]).sort(), [["https://github.com/never-graded", true], ["https://linktr.ee/someone", true]]);
  const [row] = await reviewsOf(db, "https://github.com/never-graded");
  assert.equal(String(row.decided_by), ADDRESS_RULE_ACTOR);
  assert.notEqual(ADDRESS_RULE_ACTOR, DOOR_RULE_ACTOR);
  assert.equal(await hidden(db, "https://github.com/never-graded"), true);
  assert.equal(await notPortfolio(db, "https://github.com/never-graded"), true);
  assert.equal(String(await col(db, "https://github.com/never-graded", "health")), "down", "the weekly health run moves it to data/excluded.json, as any removal");
  assert.equal(await hidden(db, "https://github.com/graded-yes"), false, "waits for the owner");

  // The owner confirms the held one: his removal, through the same path.
  const [c] = await decideReviews(db, { ids: [Number(held.id)], action: "confirm", actor: "admin:owner", onFeed: () => true, now: new Date(T0 + 2 * 3600000) });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(await hidden(db, "https://github.com/graded-yes"), true);
});

test("the roster: a waiting address row is closed, not applied, once the owner or a newer grade has decided", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const url = "https://gitlab.com/someone";
  await site(db, url, { n: 3 });
  await syncReviewRows(db, { now: new Date(T0) });
  // Graded after the row was written (with the switch off the row waited): the door decided since.
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?", args: [JSON.stringify({ ...answer(true), judged_at: new Date(T0 + 1000).toISOString() }), url] });
  const [r] = await autoApplyReviews(db, { onFeed: () => true, now: new Date(T0 + 3600000) });
  assert.equal(r.closed, true, JSON.stringify(r));
  assert.equal(await hidden(db, url), false);
});
