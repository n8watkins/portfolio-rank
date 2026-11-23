// The independent review of the removal rule (the door, lib/reviews/door.mjs,
// pull request #238): one test per finding, each written to fail on the code
// before its fix.
//   a  a stored capture from before the capture fix (#235) that shows a gate is
//      never sent to Gemini and never removed; it is captured again first
//   b  after the owner undoes or rejects a removal the site gets one fresh grade
//      after its next capture, and until then shows no grade
//   c  Undo still works after the site's row was purged
//   d  a bot-walled site graded a portfolio later has its bot-wall row closed
//   e  a retried Workflow step loses nothing from the night's summary
// Offline: a throwaway database, a simulated clock and a mocked Gemini
// (tests/helpers/door-night.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BOT_WALL_REASON, capturedBlocked } from "../pipeline/capture-blocked.mjs";
import { atTheDoor } from "../lib/reviews/door.mjs";
import { decideReviews, ensureReviewSchema, listReviews, undoneRemovals, undoReviews } from "../lib/reviews/store.mjs";
import { storedCaptureBlocked } from "../lib/reviews/stored-capture.mjs";
import { finishNight, planNight, runBatch, scanStoredCaptures, startNight } from "../pipeline/night.mjs";
import { RUBRIC_VERSION, gradeRecord, parseRubricResponse } from "../pipeline/rubric.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { DAY, T0, answer, col, context, drive, faulty, freshDb, grade, hidden, mockGemini, reviewsOf, site } from "./helpers/door-night.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const owner = "admin:owner";
const requests = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM gemini_requests WHERE job LIKE 'grade-%'")).rows[0].n);

// What the review found in stored captures made before #235: each one is what the capture now refuses.
const GATES = {
  "https://botwall.dev": "Just a moment... Verifying you are human. This may take a few seconds.",
  "https://picker.dev": "How would you like to see this site? Recruiter Developer",
  "https://loader.dev": "Loading 42%",
  "https://enter.dev": "Click to enter",
};

test("a: four stored gate captures are never sent to Gemini, never removed, and go back for a new capture; the bot wall goes to the owner", async () => {
  const { db } = await freshDb();
  for (const [u, text] of Object.entries(GATES)) {
    assert.ok(capturedBlocked({ text, title: "", outboundLinks: 0 }), `the capture's rule refuses ${u}`);
    await site(db, u, { text, n: 0, needsReview: 1 });
  }
  const { ctx, clock } = context(db, { gemini: Object.fromEntries(Object.keys(GATES).map((u) => [u, answer(false)])) });
  ctx.flags.pollGeneration = "false";
  const n = await drive(ctx, clock);

  assert.equal(await requests(db), 0, "nothing sent to Gemini");
  assert.deepEqual(n.summary.sites.removed, [], "none removed");
  assert.equal(n.summary.sites.counts.graded, 0);
  for (const u of Object.keys(GATES)) {
    assert.equal(await grade(db, u), null, `${u}: no grade stored`);
    // Recorded as the capture records a blocked capture of a site without a good one: retried at once.
    assert.equal(String(await col(db, u, "status")), "error");
    assert.match(String(await col(db, u, "reason")), /^capture blocked: /);
    assert.ok(await col(db, u, "retry_at"), `${u}: due for a new capture`);
  }
  assert.equal(String(await col(db, "https://botwall.dev", "reason")), BOT_WALL_REASON);
  // The bot wall goes to the owner's review, as the capture would have sent it.
  assert.deepEqual((await reviewsOf(db, "https://botwall.dev")).map((r) => `${r.grp}:${r.status}`), ["bot_wall:pending"]);
  assert.deepEqual(n.summary.sites.review.map((r) => r.url), ["https://botwall.dev"]);
  for (const u of ["https://picker.dev", "https://loader.dev", "https://enter.dev"]) assert.deepEqual(await reviewsOf(db, u), []);
  // The summary says how many were set aside and why.
  assert.equal(n.summary.unusableCapture.count, 4);
  assert.deepEqual(n.summary.unusableCapture.byWhy, {
    "a bot or security check stood in for the site": 1,
    "still a gate or loader after the click-through": 2,
    "10 words and no outbound links": 1,
  });
  assert.equal(n.summary.sites.counts.setAside, 4);
  assert.match(n.markdown, /Set aside before grading, their stored capture does not show the site .*: 4/);

  // A good capture later puts it back in the queue: the capture writes status 'live' with the new text.
  await db.execute("UPDATE portfolios SET status = 'live', reason = '', page_text = 'Ann Lee. Projects. About me. Contact. Resume.', captured_at = '2026-11-18 12:00:00' WHERE url = 'https://loader.dev'");
  const c2 = context(db, { gemini: {}, start: T0 + 2 * DAY });
  c2.ctx.flags.pollGeneration = "false";
  const n2 = await drive(c2.ctx, c2.clock);
  assert.deepEqual(n2.summary.sites.graded.map((g) => g.url), ["https://loader.dev"]);
  assert.equal((await grade(db, "https://loader.dev")).is_portfolio, true);
});

test("a: only a capture from before #235 is judged from what is stored; a later one passed the capture's own check", () => {
  const short = { page_text: "Ann Lee. Projects. About me. Contact. Resume.", facts: JSON.stringify({ signals: { name: true, score: 1 } }), meta: "{}" };
  assert.match(storedCaptureBlocked({ ...short, captured_at: "2026-11-16 12:00:00" }), /no outbound links/);
  // An older capture whose facts found a GitHub link links out.
  assert.equal(storedCaptureBlocked({ ...short, captured_at: "2026-11-16 12:00:00", facts: JSON.stringify({ github: true }) }), null);
  assert.match(storedCaptureBlocked({ ...short, page_text: "Loading 42%", captured_at: "2026-11-16 12:00:00" }), /gate or loader/);
  // Since #235 the capture judged the screen after the scroll-through, its title and links; the stored text is
  // an earlier snapshot of the same page and is never judged again (a slow preloader would loop otherwise).
  assert.equal(storedCaptureBlocked({ ...short, captured_at: "2026-11-17 12:00:00" }), null);
  assert.equal(storedCaptureBlocked({ ...short, page_text: "Loading 87%", captured_at: "2026-11-20 12:00:00" }), null);
  assert.equal(storedCaptureBlocked({ ...short, page_text: GATES["https://botwall.dev"], captured_at: "2026-11-20 12:00:00" }), null);
});

test("review 2: a site stored since #235 with a preloader's text is graded, not set aside every night", async () => {
  const { db } = await freshDb();
  const url = "https://slow-loader.dev";
  // capture.mjs stores the text read before the scroll-through; its check passed on the screen after it.
  await site(db, url, { text: "Loading 87%", n: 3 });
  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-17 02:00:00' WHERE url = ?", args: [url] });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(true) } });
  ctx.flags.pollGeneration = "false";
  const n = await drive(ctx, clock);
  assert.equal(String(await col(db, url, "status")), "live", "never turned into a failed capture");
  assert.equal(n.summary.unusableCapture.count, 0);
  assert.equal((await grade(db, url)).is_portfolio, true);
});

test("a: a grade that reaches the door anyway (the fallback grader) is not stored and never removes the site", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const url = "https://enter.dev";
  await site(db, url, { text: GATES[url], n: 0 });
  const row = (await db.execute({ sql: "SELECT url, name, shot_key, meta, ai_rubric, page_text, facts, signals FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  const g = gradeRecord({ parsed: parseRubricResponse(answer(false)), model: PRIMARY_MODEL, facts: null, source: "r2", now: new Date(T0) });
  let wrote = false;
  const door = await atTheDoor(db, {
    grade: g,
    row,
    now: new Date(T0),
    autoApply: true,
    gradeStatements: async () => {
      wrote = true;
      return [];
    },
  });
  assert.equal(door.outcome, "unusable_capture");
  assert.equal(wrote, false, "the grade is not written");
  assert.equal(await grade(db, url), null);
  assert.deepEqual(await reviewsOf(db, url), [], "no removal row");
  assert.equal(String(await col(db, url, "status")), "error", "set aside for a new capture");
});

test("a: the fallback grader (judge.mjs rubric) stores no grade and removes nothing for a stored gate capture", async () => {
  const { db, dir, file } = await freshDb();
  const url = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"))[0].url;
  await site(db, url, { text: GATES["https://loader.dev"], n: 0 });
  const r = spawnSync(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", "rubric", "--rpm", "60000", "--no-browser"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${file}`,
      TURSO_AUTH_TOKEN: "",
      GEMINI_API_KEY: "test-key-not-real",
      SHOTS_BASE_URL: "https://shots.test",
      GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
      MOCK_GEMINI: JSON.stringify([{ json: answer(false) }]),
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // Checked before the request (review 6): nothing sent to Gemini, and not counted as judged.
  assert.match(r.stdout, /set aside, not sent to Gemini/);
  assert.match(r.stdout, /rubric done: 0\/1 judged, .*1 set aside/);
  assert.match(r.stdout, /0 API request\(s\)/);
  assert.equal(await grade(db, url), null);
  assert.deepEqual(await reviewsOf(db, url), []);
  assert.equal(await hidden(db, url), true, "a failed capture until a new one shows the site");
  assert.equal(String(await col(db, url, "reason")), "capture blocked: still a gate or loader after the click-through");
});

test("a: a site in the queue whose stored capture shows a bot check is set aside even when it reaches the stage", async () => {
  // planNight sets them aside; a site that becomes ready after it (a capture written during the night) is
  // checked again in the stage, before any request.
  const { db } = await freshDb();
  const { ctx } = context(db, { gemini: { "https://late-wall.dev": answer(false) } });
  ctx.flags.pollGeneration = "false";
  let state = await planNight(ctx, await startNight(ctx));
  await site(db, "https://late-wall.dev", { text: GATES["https://botwall.dev"], n: 0 });
  let steps = 0;
  while (!state.done && steps++ < 50) state = (await runBatch(ctx, state)).state;
  const fin = await finishNight(ctx, state);
  assert.equal(await requests(db), 0);
  assert.equal(await grade(db, "https://late-wall.dev"), null);
  const stage = fin.summary.stages.find((s) => s.key === "grade_new");
  assert.equal(stage.unusable, 1);
  assert.equal(stage.result, "done: nothing left", "a stage that set its sites aside had work (review 10)");
  assert.match(fin.markdown, /\| Bad capture \|/);
  assert.deepEqual(fin.summary.sites.review.map((r) => r.url), ["https://late-wall.dev"]);
});

test("b: after Undo the site shows no grade, is not graded on the old capture, and gets exactly one real grade after a new capture", async () => {
  const { db } = await freshDb();
  const url = "https://undone.dev";
  await site(db, url, { n: 1 });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  ctx.flags.pollGeneration = "false";
  await drive(ctx, clock);
  assert.equal(await hidden(db, url), true, "removed");
  const [row] = await reviewsOf(db, url);
  await undoReviews(db, { ids: [Number(row.id)], actor: owner, now: new Date(clock.t + 3600000) });
  assert.equal(await hidden(db, url), false, "listed again");
  const after = await grade(db, url);
  assert.equal(after.error, "fresh_grade_due", "the 'no' grade's scores are not its grade");
  assert.equal(after.tier, undefined);
  assert.ok(Number((await db.execute({ sql: "SELECT forced_at FROM site_freshness WHERE url = ?", args: [url] })).rows[0].forced_at) > 0, "a new capture is asked for");
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM rubric_history WHERE url = ?", args: [url] })).rows[0].n) >= 1, true, "the old grade is in the history");

  // No new capture yet: nothing to grade.
  const c1 = context(db, { gemini: {}, start: T0 + DAY });
  c1.ctx.flags.pollGeneration = "false";
  assert.equal((await drive(c1.ctx, c1.clock)).summary.sites.counts.graded, 0);

  // A good capture: graded once, a real grade.
  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-20 12:00:00' WHERE url = ?", args: [url] });
  const c2 = context(db, { gemini: {}, start: T0 + 5 * DAY });
  c2.ctx.flags.pollGeneration = "false";
  const n2 = await drive(c2.ctx, c2.clock);
  assert.equal(n2.summary.sites.counts.graded, 1);
  const g = await grade(db, url);
  assert.equal(g.rubric_version, RUBRIC_VERSION, "a real grade (rubric v3 has no letter)");
  assert.equal(g.is_portfolio, true);
  assert.equal(g.five_second_test.score, 3);
  assert.deepEqual((await reviewsOf(db, url)).map((r) => String(r.status)), ["closed"], "the undone row is settled by the grade");

  // Exactly one: the next night grades nothing.
  const c3 = context(db, { gemini: {}, start: T0 + 6 * DAY });
  c3.ctx.flags.pollGeneration = "false";
  assert.equal((await drive(c3.ctx, c3.clock)).summary.sites.counts.graded, 0);
});

test("b: after Reject the site is kept with no scores shown, and its one fresh grade keeps it as the owner's choice", async () => {
  const { db } = await freshDb();
  const url = "https://kept.dev";
  await site(db, url, { n: 5 });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  ctx.flags.pollGeneration = "false";
  await drive(ctx, clock);
  const [row] = await reviewsOf(db, url);
  assert.equal(String(row.grp), "door_strong_signals");
  await decideReviews(db, { ids: [Number(row.id)], action: "reject", actor: owner, onFeed: () => true, now: new Date(clock.t + 3600000) });
  const kept = await grade(db, url);
  assert.equal(kept.review.kind, "owner_kept");
  assert.equal(kept.is_portfolio, true);
  assert.equal(kept.tier, undefined, "no tier until the fresh grade");
  assert.equal(kept.five_second_test, undefined, "no scores until the fresh grade");

  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-20 12:00:00' WHERE url = ?", args: [url] });
  const c2 = context(db, { gemini: { [url]: answer(false) }, start: T0 + 5 * DAY });
  c2.ctx.flags.pollGeneration = "false";
  const n2 = await drive(c2.ctx, c2.clock);
  assert.equal(n2.summary.sites.counts.graded, 1);
  const g = await grade(db, url);
  assert.equal(g.review.kind, "owner_kept", "Gemini still says no: the owner's keep holds");
  assert.equal(g.is_portfolio, true);
  assert.equal(g.ai_is_portfolio, false);
  assert.equal(g.five_second_test.score, 1, "now with the fresh grade's own scores");
  assert.equal(g.fresh_grade, undefined, "the fresh grade is done");
  assert.equal((await listReviews(db)).pending.length, 0, "nothing new asked of the owner");
  assert.equal(await hidden(db, url), false);
});

test("c: Undo after the site's row was purged succeeds and brings the site back through the daily sync", async () => {
  const { db } = await freshDb();
  const url = "https://late.dev";
  await site(db, url, { n: 1 });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  ctx.flags.pollGeneration = "false";
  await drive(ctx, clock);
  const id = Number((await reviewsOf(db, url))[0].id);
  // What purgeDelisted does 30 days after the weekly export took it off the list.
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [url] });
  const [r] = await undoReviews(db, { ids: [id], actor: owner, now: new Date(clock.t + 40 * DAY) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reversed, "relist");
  assert.match(r.note, /comes back as a new site/);
  const [back] = await reviewsOf(db, url);
  assert.equal(String(back.status), "pending");
  assert.ok(back.undone_at);
  assert.match(JSON.parse(String(back.applied)).undo.note, /daily sync lists it again/, "the admin page shows why");
  assert.deepEqual((await undoneRemovals(db)).map((u) => u.url), [url], "the daily sync relists it");
});

test("d: a bot-walled site that is later captured and graded a portfolio has its bot-wall row closed and needs_review cleared", async () => {
  const { db } = await freshDb();
  const url = "https://wall-yes.dev";
  await site(db, url, { n: 1, status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  const c1 = context(db, {});
  c1.ctx.flags.pollGeneration = "false";
  await drive(c1.ctx, c1.clock);
  assert.deepEqual((await reviewsOf(db, url)).map((r) => `${r.grp}:${r.status}`), ["bot_wall:pending"]);
  await db.execute({ sql: "UPDATE portfolios SET status = 'live', reason = '', shot_key = 'kw', captured_at = '2026-11-17 12:00:00' WHERE url = ?", args: [url] });
  const c2 = context(db, { gemini: { [url]: answer(true) }, start: T0 + DAY });
  c2.ctx.flags.pollGeneration = "false";
  await drive(c2.ctx, c2.clock);
  assert.equal((await grade(db, url)).is_portfolio, true);
  assert.deepEqual((await reviewsOf(db, url)).map((r) => `${r.grp}:${r.status}`), ["bot_wall:closed"]);
  assert.equal(Number(await col(db, url, "needs_review")), 0);
});

test("e: a Workflow step retried after its writes loses no site from the summary, removals included", async () => {
  const { db } = await freshDb();
  for (let i = 0; i < 4; i++) await site(db, `https://c${i}.dev`, { n: 2 });
  const gem = Object.fromEntries([0, 1, 2, 3].map((i) => [`https://c${i}.dev`, answer(i % 2 === 0)]));
  const { ctx } = context(db, { gemini: gem, budget: { batch: 2 } });
  ctx.fetchImpl = mockGemini(gem);
  ctx.flags.pollGeneration = "false";
  let state = await planNight(ctx, await startNight(ctx));
  await runBatch(ctx, state); // its result is lost
  state = (await runBatch(ctx, state)).state; // the retry, from the same state
  let steps = 0;
  while (!state.done && steps++ < 50) state = (await runBatch(ctx, state)).state;
  const fin = await finishNight(ctx, state);
  assert.deepEqual(fin.summary.sites.graded.map((g) => g.url).sort(), ["https://c0.dev", "https://c1.dev", "https://c2.dev", "https://c3.dev"]);
  assert.deepEqual(fin.summary.sites.removed.map((r) => r.url).sort(), ["https://c1.dev", "https://c3.dev"]);
  assert.equal(fin.summary.sites.counts.graded, 4);
  const stage = fin.summary.stages.find((s) => s.key === "grade_new");
  assert.equal(stage.done, 4);
  assert.equal(stage.requests, 4, "every request written tonight counts");
  assert.match(fin.markdown, /Removed automatically \(2\)/);
});

// --- The code review of this change (#249): one test per finding.

/** Runs a night from `start` over the database with Gemini answering `gemini`, and image as given. */
const night = async (db, { gemini = {}, start, image } = {}) => {
  const { ctx, clock } = context(db, { gemini, start });
  ctx.flags.pollGeneration = "false";
  if (image) ctx.image = image;
  return drive(ctx, clock);
};
const recapture = (db, url, at) => db.execute({ sql: "UPDATE portfolios SET captured_at = ? WHERE url = ?", args: [at, url] });
const failuresTable = (db) =>
  db.execute("CREATE TABLE IF NOT EXISTS night_item_failures (job TEXT NOT NULL, item TEXT NOT NULL, nights INTEGER NOT NULL, last_night TEXT NOT NULL, reason TEXT, parked_at TEXT, PRIMARY KEY (job, item))");

test("review 1: an undone removal stays relisted after the site's fresh grade, whatever that grade says", async () => {
  for (const fresh of [true, false]) {
    const { db } = await freshDb();
    const url = `https://undone-${fresh}.dev`;
    await site(db, url, { n: 1 });
    await night(db, { gemini: { [url]: answer(false) } });
    const [row] = await reviewsOf(db, url);
    await undoReviews(db, { ids: [Number(row.id)], actor: owner, now: new Date(T0 + 3600000) });
    assert.deepEqual((await undoneRemovals(db)).map((u) => u.url), [url]);
    await recapture(db, url, "2026-11-20 12:00:00");
    const n = await night(db, { gemini: { [url]: answer(fresh) }, start: T0 + 5 * DAY });
    assert.equal(n.summary.sites.counts.graded, 1);
    assert.equal(String((await reviewsOf(db, url))[0].status), "closed", "the fresh grade closed the undone row");
    assert.deepEqual((await undoneRemovals(db)).map((u) => u.url), [url], `still relisted after a fresh "${fresh ? "yes" : "no"}"`);
    assert.equal(await hidden(db, url), false);
  }
});

test("review 3: a missing screenshot keeps the owner's keep waiting for its fresh grade, and the fresh 'no' asks him nothing", async () => {
  const { db } = await freshDb();
  const url = "https://kept-missing.dev";
  await site(db, url, { n: 5 });
  await night(db, { gemini: { [url]: answer(false) } });
  const [row] = await reviewsOf(db, url);
  await decideReviews(db, { ids: [Number(row.id)], action: "reject", actor: owner, onFeed: () => true, now: new Date(T0 + 3600000) });
  await recapture(db, url, "2026-11-20 12:00:00");
  await night(db, { gemini: { [url]: answer(false) }, start: T0 + 4 * DAY, image: async () => "missing" });
  const waiting = await grade(db, url);
  assert.equal(waiting.review.kind, "owner_kept", "the owner's keep survives a missing screenshot");
  assert.equal(waiting.fresh_grade, "due");
  assert.equal(waiting.error, undefined, "not replaced by a missing-screenshot marker");
  // Not tried again until a newer capture.
  assert.equal((await night(db, { gemini: { [url]: answer(false) }, start: T0 + 5 * DAY })).summary.sites.counts.graded, 0);
  await recapture(db, url, "2026-11-23 12:00:00");
  await night(db, { gemini: { [url]: answer(false) }, start: T0 + 7 * DAY });
  const g = await grade(db, url);
  assert.equal(g.review.kind, "owner_kept");
  assert.equal(g.rubric_version, RUBRIC_VERSION);
  assert.equal((await listReviews(db)).pending.length, 0, "nothing new asked of the owner");
});

test("review 4: Reject and Undo of a 'no' made on a checked capture keep its grade; no second request", async () => {
  const { db } = await freshDb();
  const kept = "https://checked-kept.dev";
  const undone = "https://checked-undone.dev";
  await site(db, kept, { n: 5 });
  await site(db, undone, { n: 1 });
  // Captured after #235: the capture checked the screen.
  await recapture(db, kept, "2026-11-17 02:00:00");
  await recapture(db, undone, "2026-11-17 02:00:00");
  await night(db, { gemini: { [kept]: answer(false), [undone]: answer(false) } });
  const [k] = await reviewsOf(db, kept);
  await decideReviews(db, { ids: [Number(k.id)], action: "reject", actor: owner, onFeed: () => true, now: new Date(T0 + 3600000) });
  const gk = await grade(db, kept);
  assert.equal(gk.review.kind, "owner_kept");
  assert.equal(gk.rubric_version, RUBRIC_VERSION, "the grade stays (graded once)");
  assert.equal(gk.fresh_grade, undefined);
  const [u] = await reviewsOf(db, undone);
  await undoReviews(db, { ids: [Number(u.id)], actor: owner, now: new Date(T0 + 3600000) });
  const gu = await grade(db, undone);
  assert.equal(gu.error, undefined, "Undo puts the grade back as it was");
  assert.equal(gu.ai_is_portfolio, false);
  assert.equal(gu.rubric_version, RUBRIC_VERSION);
  await recapture(db, kept, "2026-11-20 12:00:00");
  await recapture(db, undone, "2026-11-20 12:00:00");
  assert.equal((await night(db, { start: T0 + 5 * DAY })).summary.sites.counts.graded, 0, "no fresh grade is due");
});

test("review 5: a failed summary write never fails the grade or the night", async () => {
  const { db: real } = await freshDb();
  const url = "https://note-fails.dev";
  await site(real, url, { n: 3 });
  const noteWrite = (s) => /INSERT INTO night_sites/.test(s);
  const { db } = faulty(real, { failBatch: (sqls) => sqls.some(noteWrite), failExecute: noteWrite });
  const n = await night(db, { gemini: { [url]: answer(true) } });
  assert.equal(n.status, "complete");
  assert.equal((await grade(real, url)).is_portfolio, true);
  assert.deepEqual(n.summary.sites.graded.map((g) => g.url), [url], "this attempt's own lists stand in");
  assert.deepEqual(n.summary.sites.failed, []);
  assert.equal(n.summary.stages.find((s) => s.key === "grade_new").failed, 0);
  assert.ok(n.summary.unrecorded >= 1);
});

test("review 7: a site that failed in a lost attempt and was graded on the retry is listed as graded only", async () => {
  const { db } = await freshDb();
  const url = "https://flaky.dev";
  await site(db, url, { n: 3 });
  const { ctx } = context(db, { gemini: { [url]: answer(true) } });
  ctx.flags.pollGeneration = "false";
  const good = ctx.fetchImpl;
  let state = await planNight(ctx, await startNight(ctx));
  ctx.fetchImpl = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{not json" }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
  const lost = await runBatch(ctx, state); // fails the site; its result is lost
  assert.equal((lost.state.stage ?? lost.state.stages.at(-1)).failed, 1);
  ctx.fetchImpl = good;
  let steps = 0;
  while (!state.done && steps++ < 50) state = (await runBatch(ctx, state)).state;
  const fin = await finishNight(ctx, state);
  assert.deepEqual(fin.summary.sites.graded.map((g) => g.url), [url]);
  assert.deepEqual(fin.summary.sites.failed, [], "the final outcome wins");
  const stage = fin.summary.stages.find((s) => s.key === "grade_new");
  assert.deepEqual([stage.done, stage.failed], [1, 0]);
});

test("review 8: the stored-capture check reads the queue a page at a time and only unchecked captures", async () => {
  const { db } = await freshDb();
  await failuresTable(db);
  for (let i = 0; i < 5; i++) await site(db, `https://gate${i}.dev`, { text: "Click to enter", n: 0 });
  await site(db, "https://fine.dev", { n: 3 });
  await site(db, "https://checked.dev", { text: "Click to enter", n: 0 });
  await recapture(db, "https://checked.dev", "2026-11-17 02:00:00");
  const pages = [];
  const r = await scanStoredCaptures(db, { pageSize: 2, onPage: async (page, scanned) => void pages.push([page.length, scanned]) });
  assert.deepEqual(r, { scanned: 6, blocked: 5 }, "the capture checked since #235 is not read");
  assert.deepEqual(pages, [[1, 2], [2, 4], [2, 6]]);
  assert.equal(String(await col(db, "https://gate0.dev", "status")), "live", "scanning writes nothing");
});

test("review 10: a stored-capture check that fails is said in the summary, and each grade still checks its own site", async () => {
  const { db: real } = await freshDb();
  const url = "https://gate-unscanned.dev";
  await site(real, url, { text: "Click to enter", n: 0 });
  const { db } = faulty(real, { failExecute: (sql) => /p\.url > \?/.test(sql) });
  const n = await night(db, { gemini: { [url]: answer(false) } });
  assert.match(n.summary.unusableCapture.error, /injected failure/);
  assert.match(n.markdown, /The check of stored captures did not finish/);
  assert.equal(await requests(real), 0, "set aside in the stage, before any request");
  assert.equal(await grade(real, url), null);
});

test("dry run: the script counts what the first night would set aside, with examples, and writes nothing", async () => {
  const { db, file } = await freshDb();
  await ensureReviewSchema(db);
  await failuresTable(db);
  for (const [u, text] of Object.entries(GATES)) await site(db, u, { text, n: 0 });
  await site(db, "https://fine.dev", { n: 3 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TURSO_/.test(k)));
  const r = spawnSync(process.execPath, ["scripts/stored-capture-dry-run.mjs"], { cwd: ROOT, env: { ...env, LOCAL_DB_FILE: file }, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /Would be set aside: 4/);
  assert.match(r.stdout, /## still a gate or loader after the click-through: 2/);
  assert.match(r.stdout, /- https:\/\/botwall\.dev .*Just a moment/);
  for (const u of Object.keys(GATES)) assert.equal(String(await col(db, u, "status")), "live", "nothing written");
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM status_reviews")).rows[0].n), 0);
});
