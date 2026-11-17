// The second code review of pull request #238 (the door, lib/reviews/door.mjs):
// one test per finding, each written to fail on the code before its fix.
// Offline: a throwaway database, a simulated clock and a mocked Gemini
// (tests/helpers/door-night.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runHealthCheck } from "../pipeline/health.mjs";
import { planExclusions } from "../pipeline/exclusions.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { HELD_KINDS, guardedForReview } from "../pipeline/portfolio-guard.mjs";
import { REMOVED_KINDS } from "../lib/removed-kinds.mjs";
import * as store from "../lib/reviews/store.mjs";
import { autoApplyReviews, decideReviews, ensureReviewSchema, listReviews, undoReviews } from "../lib/reviews/store.mjs";
import { syncReviewRows } from "../lib/reviews/door.mjs";
import { BOT_WALL_REASON, isBotWallReason } from "../pipeline/capture-blocked.mjs";
import { DAY, EMPTY_HTML, PORTFOLIO_HTML, T0, answer, col, context, drive, faulty, freshDb, grade, hidden, reviewsOf, signals, site } from "./helpers/door-night.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const owner = "admin:owner";
const later = (h) => new Date(T0 + h * 3600000);

/** Every site's open rows and held grades: a held grade has exactly one open row, and no site has two. */
async function assertOneCase(db, when) {
  const rows = (await db.execute("SELECT url, ai_rubric, (SELECT COUNT(*) FROM status_reviews r WHERE r.url = p.url AND r.status = 'pending') AS open FROM portfolios p")).rows;
  for (const r of rows) {
    const g = r.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
    const open = Number(r.open);
    assert.ok(open <= 1, `${when}: ${r.url} has ${open} open rows`);
    if (guardedForReview(g)) assert.equal(open, 1, `${when}: ${r.url} has a held grade and ${open} open rows`);
  }
}

/** A page change after the last grade, so the "grade changed sites" stage grades the site again. */
const changed = (db, url, at) => db.execute({ sql: "INSERT INTO rating_resets (url, at, reason) VALUES (?, ?, 'page_changed')", args: [url, new Date(at).toISOString()] });
const regradeNight = (db, url, start, no = true) => {
  const { ctx, clock } = context(db, { gemini: { [url]: answer(!no) }, budget: { stages: { grade_changed: { cap: 50 } } }, start, autoApply: false });
  return drive(ctx, clock);
};

test("1: a site the owner kept by rejecting a door removal is not reopened as 'signals collapsed' after the weekly check", async () => {
  const { db } = await freshDb();
  const url = "https://kept-then-empty.dev";
  await site(db, url, { n: 2 });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  await drive(ctx, clock);
  const [row] = await reviewsOf(db, url);
  await undoReviews(db, { ids: [Number(row.id)], actor: owner, now: later(1) });
  await decideReviews(db, { ids: [Number(row.id)], action: "reject", actor: owner, onFeed: () => true, now: later(2) });
  assert.equal((await grade(db, url)).review.kind, "owner_kept");
  // The weekly check finds nothing that looks like a portfolio: needs_review comes back.
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => EMPTY_HTML });
  await runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }], fetchImpl, log: () => {}, now: new Date(clock.t + 3 * DAY) });
  assert.equal(Number(await col(db, url, "needs_review")), 1);
  const r = await syncReviewRows(db, { now: new Date(clock.t + 4 * DAY) });
  assert.deepEqual(r.collapsed, [], "the owner already decided to keep it");
  assert.equal((await reviewsOf(db, url)).filter((x) => String(x.status) === "pending").length, 0);
});

test("2: a failing Reject puts its row back to pending with the error, and the rest of the selection still applies", async () => {
  const { db: real } = await freshDb();
  const a = "https://settle-fails.dev";
  const b = "https://settle-works.dev";
  await site(real, a, { n: 5 });
  await site(real, b, { n: 5 });
  const { ctx, clock } = context(real, { gemini: { [a]: answer(false), [b]: answer(false) } });
  await drive(ctx, clock);
  const ra = (await reviewsOf(real, a))[0];
  const rb = (await reviewsOf(real, b))[0];
  let failures = 1;
  const { db } = faulty(real, { failBatch: (sqls) => sqls.some((s) => /SET needs_review = 0/.test(s)) && failures-- > 0 });
  const res = await decideReviews(db, { ids: [Number(ra.id), Number(rb.id)], action: "reject", actor: owner, onFeed: () => true, now: later(1), concurrency: 1 });
  assert.deepEqual(res.map((r) => r.ok), [false, true]);
  const back = (await reviewsOf(real, a))[0];
  assert.equal(String(back.status), "pending", "the failed row waits for the owner again");
  assert.match(JSON.parse(String(back.applied)).error, /injected failure/);
  assert.equal((await grade(real, a)).review.kind, "strong_signals", "its hold is untouched and can still be settled");
  assert.equal((await grade(real, b)).review.kind, "owner_kept");
});

test("3: the public reason for a removal is a plain statement; who decided is kept apart (decided_by, evidence)", async () => {
  const { db } = await freshDb();
  const rule = "https://rule-removed.dev";
  const mine = "https://owner-removed.dev";
  await site(db, rule, { n: 2 });
  await site(db, mine, { n: 5 });
  const { ctx, clock } = context(db, { gemini: { [rule]: answer(false), [mine]: answer(false) } });
  await drive(ctx, clock);
  const [held] = await reviewsOf(db, mine);
  await decideReviews(db, { ids: [Number(held.id)], action: "confirm", actor: owner, onFeed: () => true, now: new Date(clock.t + 3600000) });
  const feed = [{ url: rule, name: "R" }, { url: mine, name: "M" }, ...[...Array(30)].map((_, i) => ({ url: `https://filler-${i}.dev`, name: "F" }))];
  const plan = await planExclusions({ db, excluded: [], feed, now: new Date(clock.t + 3 * DAY) });
  const by = Object.fromEntries(plan.added.map((e) => [e.url, e]));
  // What /removed prints (app/removed/page.tsx): the kind's label, then the reason.
  const shown = (e) => `${REMOVED_KINDS[e.kind]} - ${e.reason}`;
  assert.equal(shown(by[rule]), "Not a portfolio - AI grading says this is not a portfolio");
  assert.equal(shown(by[mine]), "Not a portfolio - AI grading says this is not a portfolio (confirmed by the owner)");
  for (const e of plan.added) assert.doesNotMatch(e.reason, /admin|Undo|\/|rule:/, e.url);
  assert.equal(by[rule].decided_by, "rule:gemini-not-portfolio");
  assert.equal(by[mine].decided_by, "owner");
  assert.ok(by[rule].evidence.review > 0 && /no work shown/.test(by[rule].evidence.gemini));
  // Texts this pull request stores in a grade (it can reach public pages) carry no admin paths either.
  for (const u of [rule, mine]) assert.doesNotMatch(JSON.stringify((await grade(db, u)).review ?? {}), /\/admin|REVIEW_AUTO_APPLY/, u);
});

test("4: a held grade always has exactly one open row describing it, whatever the order of grades and decisions", async () => {
  const { db } = await freshDb();
  const url = "https://regraded.dev";
  await site(db, url, { n: 2 });
  // Night 1, automatic decisions off: held, one pending row.
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) }, autoApply: false });
  await drive(ctx, clock);
  await assertOneCase(db, "after the first grade");
  // Night 2: graded again while that row waits.
  await changed(db, url, T0 + 12 * 3600000);
  await regradeNight(db, url, T0 + DAY);
  await assertOneCase(db, "after a re-grade");
  const open = (await reviewsOf(db, url)).filter((r) => String(r.status) === "pending");
  assert.equal(String(open[0].created_at), (await grade(db, url)).judged_at, "the open row describes the current grade");
  // The hourly rule applies it (not closed as stale).
  const applied = await autoApplyReviews(db, { onFeed: () => true, now: new Date(T0 + DAY + 3600000) });
  assert.deepEqual(applied.map((r) => r.ok), [true]);
  assert.equal(await hidden(db, url), true);
  // Undo, then graded again: held for the owner (he took it back), one open row.
  await undoReviews(db, { ids: [applied[0].id], actor: owner, now: new Date(T0 + DAY + 2 * 3600000) });
  await assertOneCase(db, "after the undo");
  await changed(db, url, T0 + DAY + 12 * 3600000);
  await regradeNight(db, url, T0 + 2 * DAY);
  await assertOneCase(db, "after a re-grade of an undone removal");
  // Reject settles it; graded again: still one open row at most, and the site is listed.
  const pending = (await reviewsOf(db, url)).find((r) => String(r.status) === "pending");
  await decideReviews(db, { ids: [Number(pending.id)], action: "reject", actor: owner, onFeed: () => true, now: new Date(T0 + 2 * DAY + 3600000) });
  await assertOneCase(db, "after the reject");
  await changed(db, url, T0 + 2 * DAY + 12 * 3600000);
  await regradeNight(db, url, T0 + 3 * DAY);
  await assertOneCase(db, "after a re-grade of a kept site");
  // And a re-grade that says portfolio closes the open door row.
  await changed(db, url, T0 + 3 * DAY + 12 * 3600000);
  await regradeNight(db, url, T0 + 4 * DAY, false);
  await assertOneCase(db, "after a re-grade that says portfolio");
  assert.equal(await hidden(db, url), false);
});

test("5: one open case per site across groups: an older open row is closed, and the rule never removes over a case that waited for the owner", async () => {
  const { db } = await freshDb();
  const url = "https://older-case.dev";
  await site(db, url, { n: 2 });
  await ensureReviewSchema(db);
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at)
          VALUES ('recheck-543', ?, 'live_ungraded', 'listed', 'relist', 0, '{}', '2026-11-14T00:00:00Z')`,
    args: [url],
  });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  await drive(ctx, clock);
  const rows = await reviewsOf(db, url);
  const old = rows.find((r) => String(r.grp) === "live_ungraded");
  assert.equal(String(old.status), "closed");
  assert.match(JSON.parse(String(old.applied)).closed, /superseded by the nightly grade/);
  // Two signals and Gemini's "no" would be an automatic removal on a site with no history. Here a
  // relist proposal was waiting for the owner, so the rule holds the site for him instead.
  assert.equal(rows.some((r) => String(r.grp) === "door_not_portfolio"), false, "no automatic removal over the owner's open case");
  const door = rows.find((r) => String(r.grp) === "door_held");
  assert.equal(String(door.status), "pending", "the one open case, waiting for the owner");
  assert.match(String(door.reason), /already waiting for the owner's decision/);
  assert.equal(await hidden(db, url), false, "the site stays listed until he decides");
  await assertOneCase(db, "after the door");
  assert.ok((await listReviews(db)).decided.some((r) => r.id === Number(old.id)), "the closed row is listed for the owner");
});

test("6: the 60-second request timeout is for single-site grades only; other requests keep the client's", async () => {
  const { db } = await freshDb();
  await site(db, "https://timed.dev", { n: 6 });
  const seen = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    seen.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    // The grade, then the content stage's weekly poll (a request that is not a single-site grade, like a comparison).
    const { ctx, clock } = context(db, {});
    const r = await drive(ctx, clock);
    assert.equal(r.summary.stages.find((s) => s.key === "content").requests, 1);
  } finally {
    AbortSignal.timeout = original;
  }
  assert.deepEqual(seen, [60000, 120000]);
});

test("7: a bot-wall reason with a suffix still matches, in the door's SQL and in the capture's check", async () => {
  const { db } = await freshDb();
  const url = "https://walled-suffix.dev";
  await site(db, url, { status: "error", reason: `${BOT_WALL_REASON} (3 tries)`, needsReview: 1, captured: false });
  const r = await syncReviewRows(db, { now: new Date(T0) });
  assert.deepEqual(r.botWall, [url]);
  assert.equal(isBotWallReason(`${BOT_WALL_REASON} (3 tries)`), true);
});

test("8: every held kind is known to the health check and the night's collapse rows, from one list", async () => {
  for (const src of ["pipeline/health.mjs", "lib/reviews/door.mjs"]) {
    const text = fs.readFileSync(path.join(ROOT, src), "utf8");
    // In SQL (the door's outcome named "strong_signals" is a different thing, so only SQL literals count).
    for (const kind of HELD_KINDS) assert.ok(!text.includes(`'${kind}'`), `${src} re-types the held kind ${kind} in SQL`);
    assert.ok(!text.includes('"AI grading says'), `${src} re-types the "AI grading says" reason`);
  }
  const { db } = await freshDb();
  const feed = [];
  for (const kind of HELD_KINDS) {
    const url = `https://held-${kind.replace(/_/g, "-")}.dev`;
    feed.push({ url, name: "Ann Lee" });
    assert.equal(guardedForReview({ review: { kind } }), true);
    await site(db, url, {
      rubric: { tier: "C", is_portfolio: true, ai_is_portfolio: false, review: { kind }, model: PRIMARY_MODEL, judged_at: "2026-10-01T00:00:00Z" },
      needsReview: 1,
      healthSignals: { ...signals(1), checked_at: "2026-11-16T10:00:00.000Z" },
    });
  }
  assert.deepEqual((await syncReviewRows(db, { now: new Date(T0) })).collapsed, [], "a held grade has its own case");
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML });
  await runHealthCheck({ db, feed, fetchImpl, log: () => {}, now: new Date(T0 + DAY) });
  for (const { url } of feed) assert.equal(Number(await col(db, url, "needs_review")), 1, url);
});

test("9: the dead write path is gone: no withOwnerVerdict, and the one-off script has no grading code", () => {
  assert.equal(store.withOwnerVerdict, undefined);
  const script = fs.readFileSync(path.join(ROOT, "scripts", "regrade-not-portfolio.mjs"), "utf8");
  for (const word of ["gradeFromEvidence", "replaceGradeStatements", "rankForWrite", "createGemini"]) assert.ok(!script.includes(word), word);
  assert.ok(!fs.readFileSync(path.join(ROOT, "pipeline", "night.mjs"), "utf8").includes("pacificDay"));
});

test("10: the night's review rows cost a fixed number of round trips, and the door never reads its row back", async () => {
  const { db: real } = await freshDb();
  for (let i = 0; i < 30; i++) await site(real, `https://walled-${i}.dev`, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  for (let i = 0; i < 30; i++) {
    await site(real, `https://collapsed-${i}.dev`, {
      rubric: { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, judged_at: "2026-10-01T00:00:00Z" },
      needsReview: 1,
      healthSignals: { ...signals(1), checked_at: "2026-11-16T10:00:00.000Z" },
    });
  }
  const { db, trips } = faulty(real);
  const r = await syncReviewRows(db, { now: new Date(T0) });
  assert.equal(r.botWall.length + r.collapsed.length, 60);
  assert.ok(trips.n <= 10, `${trips.n} round trips for 60 rows`);
  assert.equal(Number((await real.execute("SELECT COUNT(*) AS n FROM status_reviews")).rows[0].n), 60);
  // The door: no read-back of the row it just wrote.
  const { db: real2 } = await freshDb();
  await site(real2, "https://no-readback.dev", { n: 2 });
  const spy = faulty(real2);
  const { ctx, clock } = context(spy.db, { gemini: { "https://no-readback.dev": answer(false) } });
  await drive(ctx, clock);
  assert.ok(!spy.seen.some((s) => /SELECT \* FROM status_reviews WHERE batch = \?/.test(s)), "no read-back");
  assert.equal(await hidden(real2, "https://no-readback.dev"), true);
});
