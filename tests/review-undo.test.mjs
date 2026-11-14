// Undo on every decided row of the owner's review queue (lib/reviews/store.mjs
// undoReviews, planUndo), owner request 2026-11-14 after a "Mark checked"
// pressed by accident: the row goes back to pending, what the decision
// changed is reversed (exactly, from applied.before, for every apply since
// #220; the grade only, from rubric_history, for the earlier ones), and who
// undid it and when is recorded. Rows a rule decided (rule:duplicate) and
// rejections had nothing applied, so only the row moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { decideReviews, ownerVerdict, planUndo, undoReviews } from "../lib/reviews/store.mjs";
import { bulkWords, outcomeOf } from "../components/admin/review-labels.ts";
import { replaceGradeStatements } from "../pipeline/rubric-history.mjs";

const NOW = new Date("2026-11-16T18:00:00Z");
const LATER = new Date("2026-11-16T19:00:00Z");
const OWNER = "admin:owner";

async function freshDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "undo-")), "db.sqlite")}` });
  await migrate(db);
  return db;
}

const GRADE = (o = {}) => ({ tier: "B", is_portfolio: false, model: "gemini-3.1-flash-lite", judged_at: "2026-11-01T00:00:00Z", visual_design: { score: 3 }, quality_score: 60, ...o });

let n = 0;
const u = () => `https://undo-${++n}.dev`;

async function site(db, url, { rubric = null, status = "live", health = null, healthReason = null } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, ai_rubric, health, health_reason, health_fails, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [url, url, status, rubric == null ? null : JSON.stringify(rubric), health, healthReason, health ? 2 : 0],
  });
}

/** A row; `decided` writes it as already decided (status, by, at, applied), the way scripts and rules do. */
async function review(db, url, { proposed = "relist", decided = null } = {}) {
  const r = await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, status, decided_by, decided_at, applied, created_at)
          VALUES ('recheck-543', ?, 'not_portfolio', 'listed', ?, 1, 'why', 0, '{}', '{"junk_rule":null,"capture":{}}', ?, ?, ?, ?, '2026-11-14T10:00:00Z')`,
    args: [url, proposed, decided?.status ?? "pending", decided?.by ?? null, decided?.at ?? null, decided?.applied ? JSON.stringify(decided.applied) : null],
  });
  return Number(r.lastInsertRowid);
}

const row = async (db, url) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url] })).rows[0];
const reviewRow = async (db, id) => (await db.execute({ sql: "SELECT * FROM status_reviews WHERE id = ?", args: [id] })).rows[0];
const rubricOf = async (db, url) => {
  const r = await row(db, url);
  return r.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
const member = async (db, url) => Number((await db.execute({ sql: "SELECT member FROM tier_ratings WHERE url = ?", args: [url] })).rows[0]?.member ?? 0);
const undo = (db, ids) => undoReviews(db, { ids, actor: OWNER, now: LATER });

test("planUndo: what each kind of decided row reverses", () => {
  const r = (o) => ({ status: "confirmed", proposed: "relist", applied: null, ...o });
  assert.equal(planUndo(r({ status: "pending" })).kind, "wrong_status");
  assert.equal(planUndo(r({ status: "rejected" })).kind, "nothing");
  assert.equal(planUndo(r({ status: "rejected", applied: { rejected: true } })).kind, "nothing");
  assert.equal(planUndo(r({ proposed: "review", applied: { action: "none" } })).kind, "nothing", "Mark checked");
  assert.equal(planUndo(r({ applied: null })).kind, "nothing", "a rule row with nothing applied");
  assert.equal(planUndo(r({ applied: { grade: "flip", before: {} } })).kind, "exact");
  assert.equal(planUndo(r({ status: "auto_applied", applied: { grade: "flip", before: {} } })).kind, "exact");
  assert.deepEqual(planUndo(r({ applied: { grade: "flip", visibility: ["health set back to live"] } })), { kind: "legacy", grade: "flip", visibility: ["health set back to live"] });
});

test("Undo after Mark checked, a rejection, or a rule's decision: back to pending, logged, nothing else moves", async () => {
  const db = await freshDb();
  const urls = [u(), u(), u()];
  for (const url of urls) await site(db, url, { rubric: GRADE() });
  const marked = await review(db, urls[0], { proposed: "review" });
  await decideReviews(db, { ids: [marked], action: "confirm", actor: OWNER, onFeed: () => true, now: NOW });
  const rejected = await review(db, urls[1]);
  await decideReviews(db, { ids: [rejected], action: "reject", actor: OWNER, onFeed: () => true, now: NOW });
  const ruled = await review(db, urls[2], { proposed: "review", decided: { status: "rejected", by: "rule:duplicate", at: "2026-11-14T01:12:51.461Z" } });

  const res = await undo(db, [marked, rejected, ruled]);
  assert.deepEqual(res.map((x) => [x.ok, x.reversed]), [[true, "nothing"], [true, "nothing"], [true, "nothing"]]);
  for (const id of [marked, rejected, ruled]) {
    const r = await reviewRow(db, id);
    assert.deepEqual([r.status, r.decided_by, r.decided_at, r.undone_by, r.undone_at], ["pending", null, null, OWNER, LATER.toISOString()]);
    assert.deepEqual(JSON.parse(String(r.applied)).undo, { at: LATER.toISOString(), by: OWNER, reversed: "nothing" });
  }
  for (const url of urls) assert.equal((await rubricOf(db, url)).is_portfolio, false, "the grades never moved");
  assert.equal((await undo(db, [marked]))[0].error, "wrong_status", "a pending row has nothing to undo");
});

test("Undo after a confirmed relist restores the site exactly: grade, tier membership, health and the review flag", async () => {
  const db = await freshDb();
  const url = u();
  const before = GRADE();
  await site(db, url, { rubric: before, health: "suspect", healthReason: "AI grading says this is not a portfolio" });
  const id = await review(db, url);
  await decideReviews(db, { ids: [id], action: "confirm", actor: OWNER, onFeed: () => true, now: NOW });
  assert.equal((await rubricOf(db, url)).is_portfolio, true);
  assert.equal(await member(db, url), 1);
  assert.equal(String((await row(db, url)).health), "live");

  const [res] = await undo(db, [id]);
  assert.deepEqual([res.ok, res.reversed], [true, "exact"]);
  const back = await rubricOf(db, url);
  assert.deepEqual([back.is_portfolio, back.review, back.tier], [false, undefined, "B"]);
  assert.equal(await member(db, url), 0);
  const p = await row(db, url);
  assert.deepEqual([p.health, p.health_reason, Number(p.health_fails), Number(p.needs_review)], ["suspect", "AI grading says this is not a portfolio", 2, 1]);
  assert.equal(await ownerVerdict(db, url), null, "the verdict is gone with the decision");
  const hist = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM rubric_history WHERE url = ?", args: [url] })).rows[0].n;
  assert.equal(Number(hist), 2, "both grade changes are in the history");
});

test("Undo after a confirmed remove brings the site back on the list", async () => {
  const db = await freshDb();
  const url = u();
  await site(db, url, { rubric: GRADE({ is_portfolio: true }) });
  const id = await review(db, url, { proposed: "remove" });
  await decideReviews(db, { ids: [id], action: "confirm", actor: OWNER, onFeed: () => true, now: NOW });
  assert.equal(String((await row(db, url)).health), "down");
  await undo(db, [id]);
  const p = await row(db, url);
  assert.deepEqual([p.health, p.health_reason], [null, null]);
  assert.equal((await rubricOf(db, url)).is_portfolio, true);
});

test("a legacy confirm (no state kept, like the owner's 13 November verdicts): the grade comes back from rubric_history, the rest is reported", async () => {
  const db = await freshDb();
  const url = u();
  const old = GRADE();
  const flipped = { ...old, is_portfolio: true, ai_is_portfolio: false, review: { kind: "owner_confirmed" } };
  await site(db, url, { rubric: flipped, health: "live" });
  // What the old decideReviews wrote: the replaced grade in rubric_history at the decision's time, and no applied.before.
  await db.batch(replaceGradeStatements(url, JSON.stringify(old), flipped, NOW).filter((s) => s.sql.startsWith("INSERT")), "write");
  const id = await review(db, url, {
    decided: { status: "confirmed", by: "owner:2026-11-13", at: NOW.toISOString(), applied: { grade: "flip", visibility: ["health set back to live (it was failing only because the grade said not a portfolio)"], feed: null } },
  });
  const [res] = await undo(db, [id]);
  assert.deepEqual([res.ok, res.reversed], [true, "grade only"]);
  assert.match(res.note, /Not reversed.*health set back to live/);
  assert.equal((await rubricOf(db, url)).is_portfolio, false, "the grade before the decision is back");
  const r = await reviewRow(db, id);
  assert.equal(String(r.status), "pending");
  assert.match(JSON.parse(String(r.applied)).undo.note, /Not reversed/);

  // Without the replaced grade in the history it refuses, and the row stays decided.
  const other = u();
  await site(db, other, { rubric: flipped });
  const id2 = await review(db, other, { decided: { status: "confirmed", by: "owner:2026-11-13", at: NOW.toISOString(), applied: { grade: "flip", visibility: [] } } });
  const [bad] = await undo(db, [id2]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot reverse/);
  assert.equal(String((await reviewRow(db, id2)).status), "confirmed");
});

test("many rows decide in parallel batches: every row once, results in order, a row claimed twice applies once", async () => {
  const db = await freshDb();
  const urls = Array.from({ length: 30 }, () => u());
  const ids = [];
  for (const url of urls) {
    await site(db, url, { rubric: GRADE() });
    ids.push(await review(db, url));
  }
  const res = await decideReviews(db, { ids, action: "confirm", actor: OWNER, onFeed: () => true, now: NOW, concurrency: 8 });
  assert.deepEqual(res.map((r) => r.id), ids, "results in the order asked");
  assert.ok(res.every((r) => r.ok));
  for (const url of urls) assert.equal((await rubricOf(db, url)).is_portfolio, true);
  // Two tabs confirming the same row at once: one claim wins, the other is told.
  const url = u();
  await site(db, url, { rubric: GRADE() });
  const id = await review(db, url);
  const both = await Promise.all([
    decideReviews(db, { ids: [id], action: "confirm", actor: OWNER, onFeed: () => true, now: NOW }),
    decideReviews(db, { ids: [id], action: "confirm", actor: OWNER, onFeed: () => true, now: NOW }),
  ]);
  assert.deepEqual(both.flat().map((r) => r.ok).sort(), [false, true]);
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM rubric_history WHERE url = ?", args: [url] })).rows[0].n), 1, "applied once");
});

test("the plain words: what each confirm does, and when it shows", () => {
  const o = (proposed, group, current) => outcomeOf({ proposed, group, current });
  assert.deepEqual([o("remove", "live_ungraded", "listed").label, o("remove", "live_ungraded", "listed").when], ["Take off the list", "Off the list at once."]);
  assert.equal(o("relist", "not_portfolio", "listed").when, "Back in the rankings at once.");
  assert.equal(o("relist", "delisted_graded", "delisted").when, "Back on the list after the next daily sync.");
  assert.equal(o("relist", "delisted_ungraded", "delisted").when, "Back on the list after the next daily sync. It is ranked after its first nightly grade.");
  assert.equal(o("relist", "broken", "hidden").when, "Shows again after its next capture. It is ranked after its first nightly grade.");
  assert.equal(o("relist", "live_ungraded", "listed").when, "Ranked after its first nightly grade.");
  assert.deepEqual([o("review", "broken", "hidden").label, o("review", "broken", "hidden").question], ["Mark checked", "Confirm: mark checked?"]);
  assert.equal(o("relist", "not_portfolio", "listed").question, "Confirm: bring this site back?");

  const rows = [
    ...Array.from({ length: 3 }, () => ({ proposed: "relist", group: "delisted_graded", current: "delisted" })),
    { proposed: "relist", group: "not_portfolio", current: "listed" },
  ];
  const w = bulkWords(rows);
  assert.equal(w.button, "Confirm 4: bring these sites back");
  assert.deepEqual(w.timing, [
    { when: "Back on the list after the next daily sync.", count: 3 },
    { when: "Back in the rankings at once.", count: 1 },
  ]);
  assert.equal(bulkWords([{ proposed: "remove", group: "live_ungraded", current: "listed" }]).button, "Confirm 1: take this site off");
  assert.equal(bulkWords([...rows, { proposed: "remove", group: "live_ungraded", current: "listed" }]).button, "Confirm 5: bring back 4, take off 1");
});
