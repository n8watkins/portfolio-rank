// Captures held back for the owner other than by a bot wall (pull request #250:
// MEDIA_REVIEW_REASON, SHOWS_SITE_REASON) get a pending review row the way a
// bot-walled site does (lib/reviews/door.mjs syncReviewRows): once, and closed
// when the site is later captured and graded. Offline: a throwaway database,
// a simulated clock and a mocked Gemini (tests/helpers/door-night.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_WALL_REASON, MEDIA_REVIEW_REASON, SHOWS_SITE_REASON } from "../pipeline/capture-blocked.mjs";
import { syncReviewRows } from "../lib/reviews/door.mjs";
import { GROUPS, decideReviews, listReviews } from "../lib/reviews/store.mjs";
import { DAY, T0, answer, col, context, drive, freshDb, grade, reviewsOf, site } from "./helpers/door-night.mjs";

const REASONS = [
  ["media", MEDIA_REVIEW_REASON, /only a canvas, video or image/],
  ["error status", `${SHOWS_SITE_REASON} (HTTP 404)`, /shows a site but answered with an error status \(HTTP 404\)/],
];

for (const [name, reason, words] of REASONS) {
  test(`a capture held for ${name} gets one pending row, not a second on a later night`, async () => {
    const { db } = await freshDb();
    const url = `https://held-${name.replace(/ /g, "-")}.dev`;
    await site(db, url, { status: "error", reason, needsReview: 1, captured: false });
    const first = await syncReviewRows(db, { now: new Date(T0) });
    assert.deepEqual(first.captureReview, [url]);
    assert.deepEqual(first.botWall, []);
    const rows = await reviewsOf(db, url);
    assert.deepEqual(rows.map((r) => `${r.grp}:${r.status}:${r.proposed}`), ["capture_review:pending:review"]);
    assert.match(String(rows[0].reason), words, "the reason in plain words");
    assert.ok(!String(rows[0].reason).includes("needs owner review:"), "no internal prefix");
    assert.ok(GROUPS.capture_review, "the group has a label on the page");
    const second = await syncReviewRows(db, { now: new Date(T0 + DAY) });
    assert.deepEqual(second.captureReview, []);
    assert.equal((await reviewsOf(db, url)).length, 1);
    // It shows on the review page's list like a bot wall's row.
    const listed = await listReviews(db, {});
    assert.ok(JSON.stringify(listed).includes(url));
  });

  test(`a held-${name} row takes Mark checked like a bot wall's and is not written again`, async () => {
    const { db } = await freshDb();
    const url = `https://decided-${name.replace(/ /g, "-")}.dev`;
    await site(db, url, { status: "error", reason, needsReview: 1, captured: false });
    await syncReviewRows(db, { now: new Date(T0) });
    const [row] = await reviewsOf(db, url);
    const done = await decideReviews(db, { ids: [Number(row.id)], action: "confirm", actor: "admin:owner", onFeed: () => true, now: new Date(T0 + 3600000) });
    assert.ok(done, "decided");
    assert.equal((await reviewsOf(db, url))[0].status, "confirmed");
    assert.deepEqual((await syncReviewRows(db, { now: new Date(T0 + DAY) })).captureReview, [], "once a person looked, it is not asked again");
  });
}

test("a bot wall still gets its own bot_wall row, and a held capture does not count as one", async () => {
  const { db } = await freshDb();
  const wall = "https://wall.dev";
  const media = "https://media.dev";
  await site(db, wall, { status: "error", reason: `${BOT_WALL_REASON} (3 tries)`, needsReview: 1, captured: false });
  await site(db, media, { status: "error", reason: MEDIA_REVIEW_REASON, needsReview: 1, captured: false });
  const r = await syncReviewRows(db, { now: new Date(T0) });
  assert.deepEqual(r.botWall, [wall]);
  assert.deepEqual(r.captureReview, [media]);
  assert.deepEqual((await reviewsOf(db, wall)).map((x) => x.grp), ["bot_wall"]);
  assert.deepEqual((await reviewsOf(db, media)).map((x) => x.grp), ["capture_review"]);
});

test("a held site that is later captured and graded a portfolio has its row closed and needs_review cleared", async () => {
  const { db } = await freshDb();
  const url = "https://held-then-good.dev";
  await site(db, url, { n: 1, status: "error", reason: MEDIA_REVIEW_REASON, needsReview: 1, captured: false });
  const c1 = context(db, {});
  c1.ctx.flags.pollGeneration = "false";
  await drive(c1.ctx, c1.clock);
  assert.deepEqual((await reviewsOf(db, url)).map((r) => `${r.grp}:${r.status}`), ["capture_review:pending"]);
  await db.execute({ sql: "UPDATE portfolios SET status = 'live', reason = '', shot_key = 'kw', captured_at = '2026-11-17 12:00:00' WHERE url = ?", args: [url] });
  const c2 = context(db, { gemini: { [url]: answer(true) }, start: T0 + DAY });
  c2.ctx.flags.pollGeneration = "false";
  await drive(c2.ctx, c2.clock);
  assert.equal((await grade(db, url)).is_portfolio, true);
  assert.deepEqual((await reviewsOf(db, url)).map((r) => `${r.grp}:${r.status}`), ["capture_review:closed"]);
  assert.equal(Number(await col(db, url, "needs_review")), 0);
});
