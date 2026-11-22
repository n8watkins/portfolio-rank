// The admin's Capture problems list (lib/capture-problems.mjs): each group's
// rule on a migrated database, the record a worse re-capture writes (facts of
// the same version compared, a version change labelled as the measuring
// code), the plain-words reasons, the nightly alert line, and the review flag
// a failed refresh sets (pipeline/capture.mjs refreshNeedsReview), the
// phone-view-only bot check included.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import {
  ALERT_KEY,
  captureChange,
  captureProblemCondition,
  captureProblemConditions,
  captureProblems,
  countsOfTitle,
  plainReason,
  recordCaptureChange,
} from "../lib/capture-problems.mjs";
import { recordRefreshFailure, refreshNeedsReview } from "../pipeline/capture.mjs";
import { BLOCKED_PREFIX, BOT_WALL_REASON, MEDIA_REVIEW_REASON } from "../pipeline/capture-blocked.mjs";

let dir;
let db;
const SITE_TEXT = "Jane Doe, backend engineer. I build payment systems and developer tools that stay up at three in the morning. ".repeat(8);
const facts = (v, signs) => JSON.stringify({ v, resume: false, github: false, contact: false, internal_pages: 3, ...signs });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-problems-"));
  db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
});

after(() => {
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const site = (url, cols) => {
  const row = { name: url.replace("https://", ""), status: "live", reason: "", shot_key: "k".repeat(16), captured_at: "2026-11-20 03:00:00", page_text: SITE_TEXT, facts: facts(2, {}), ...cols };
  const keys = Object.keys(row);
  return db.execute({ sql: `INSERT OR REPLACE INTO portfolios (url, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`, args: [url, ...keys.map((k) => row[k])] });
};
const urls = (rows) => rows.map((r) => r.url);

test("captureChange: a lost sign or most of the text is worse; the same facts are not", () => {
  const prev = { facts: facts(2, { resume: true, github: true }), chars: 2000 };
  assert.equal(captureChange(prev, { facts: facts(2, { resume: true, github: true }), chars: 1900 }), null);
  const c = captureChange(prev, { facts: facts(2, { resume: true }), chars: 400 });
  assert.deepEqual(c.lost, ["github", "text"]);
  assert.equal(c.measuring, false);
  // 30% of an old text over 500 characters.
  assert.equal(captureChange({ facts: null, chars: 501 }, { facts: null, chars: 151 }), null);
  assert.deepEqual(captureChange({ facts: null, chars: 501 }, { facts: null, chars: 150 }).lost, ["text"]);
  assert.equal(captureChange({ facts: null, chars: 500 }, { facts: null, chars: 10 }), null, "an old text of 500 characters or fewer is not compared");
  // A capture whose facts could not be measured keeps the old ones: nothing lost.
  assert.equal(captureChange(prev, { facts: null, chars: 2000 }), null);
});

test("captureChange: a loss that comes with a new facts version is the measuring code's", () => {
  const c = captureChange({ facts: facts(1, { contact: true }), chars: 900 }, { facts: facts(2, {}), chars: 900 });
  assert.deepEqual(c.lost, ["contact"]);
  assert.equal(c.measuring, true);
  assert.equal(c.oldV, 1);
  assert.equal(c.newV, 2);
});

test("recordCaptureChange: one open record per site, kept against its baseline, cleared when the sign is back", async () => {
  const url = "https://d-record.dev";
  await site(url, {});
  const now = 1_800_000_000_000;
  const had = { facts: facts(2, { resume: true }), chars: 1000 };
  const lost = { facts: facts(2, {}), chars: 1000 };
  assert.equal(await recordCaptureChange(db, { url, prev: had, next: lost, now }), "recorded");
  // The next capture still lacks it: compared with the open record's old values, it stays open (updated).
  assert.equal(await recordCaptureChange(db, { url, prev: lost, next: lost, now: now + 1 }), "recorded");
  let rows = (await db.execute({ sql: "SELECT * FROM capture_changes WHERE url = ?", args: [url] })).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].at), now + 1);
  assert.equal(rows[0].cleared_at, null);
  assert.deepEqual(JSON.parse(String(rows[0].lost)), ["resume"]);
  // Back again: cleared.
  assert.equal(await recordCaptureChange(db, { url, prev: lost, next: had, now: now + 2 }), "cleared");
  rows = (await db.execute({ sql: "SELECT * FROM capture_changes WHERE url = ? AND cleared_at IS NULL", args: [url] })).rows;
  assert.equal(rows.length, 0);
  assert.equal(await recordCaptureChange(db, { url, prev: had, next: had, now: now + 3 }), null);
});

test("recordCaptureChange: a version change is written as measuring, never as a problem", async () => {
  const url = "https://d-measuring.dev";
  await site(url, {});
  assert.equal(await recordCaptureChange(db, { url, prev: { facts: facts(1, { github: true }), chars: 800 }, next: { facts: facts(2, {}), chars: 800 }, now: 1 }), "measuring");
  const { D, measuring } = await captureProblems(db);
  assert.ok(!urls(D).includes(url));
  const m = measuring.find((r) => r.url === url);
  assert.ok(m);
  assert.match(m.reason.text, /lost its GitHub link/);
  assert.match(m.reason.text, /new measuring code \(facts v1 to v2\), so it is the code, not the site/);
});

test("group A: every refresh failure, newest first, with attempts, times and the phone-view reason in plain words", async () => {
  await site("https://a-old.dev", {});
  await site("https://a-new.dev", {});
  await recordRefreshFailure(db, "https://a-old.dev", "error: HTTP 503", new Date("2026-11-20T04:00:00Z"));
  await recordRefreshFailure(db, "https://a-new.dev", `error: ${BOT_WALL_REASON} (phone view)`, new Date("2026-11-22T04:00:00Z"));
  await recordRefreshFailure(db, "https://a-new.dev", `error: ${BOT_WALL_REASON} (phone view)`, new Date("2026-11-22T05:00:00Z"));
  const { A, counts } = await captureProblems(db);
  assert.deepEqual(urls(A), ["https://a-new.dev", "https://a-old.dev"]);
  assert.equal(counts.A, 2);
  const row = A[0];
  assert.equal(row.attempts, 2);
  assert.equal(row.at, "2026-11-22T05:00:00.000Z");
  assert.ok(Date.parse(row.retryAt) > Date.parse(row.at));
  assert.equal(row.reason.phoneOnly, true);
  assert.equal(row.reason.kind, "bot");
  assert.match(row.reason.text, /only on our second visit at phone size; the desktop view showed the site/);
  assert.equal(row.onReview, false);
  assert.equal(row.capturedAt, "2026-11-20T03:00:00.000Z");
  assert.equal(A[1].reason.text, "The site answered with an error (HTTP 503).");
});

test("group B: listed sites with no good capture, not delisted ones or live ones", async () => {
  await site("https://b-dead.dev", { status: "dead", reason: "HTTP 404", shot_key: null, page_text: null, facts: null, checked_at: "2026-11-21 04:00:00", capture_attempts: 3, retry_at: "2026-11-25T04:00:00.000Z" });
  await site("https://b-wall.dev", { status: "error", reason: BOT_WALL_REASON, shot_key: null, page_text: null, facts: null, checked_at: "2026-11-22 04:00:00", capture_attempts: 1, needs_review: 1 });
  await site("https://b-gone.dev", { status: "error", reason: "HTTP 500", delisted_at: "2026-11-01", checked_at: "2026-11-22 05:00:00" });
  const { B } = await captureProblems(db);
  assert.deepEqual(urls(B), ["https://b-wall.dev", "https://b-dead.dev"]);
  assert.equal(B[0].onReview, true);
  assert.equal(B[0].reason.text, "A bot or security check stood in for the site.");
  assert.equal(B[1].attempts, 3);
  assert.equal(B[1].retryAt, "2026-11-25T04:00:00.000Z");
  assert.equal(B[1].capturedAt, null);
});

test("group C: a stored bot check, no text or under 200 characters; a good long capture is not one", async () => {
  await site("https://c-wall.dev", { page_text: "Just a moment...\nVerifying you are human. This may take a few seconds.", facts: facts(2, { internal_pages: 0 }), captured_at: "2026-11-21 03:00:00" });
  await site("https://c-none.dev", { page_text: null, captured_at: "2026-11-19 03:00:00" });
  await site("https://c-short.dev", { page_text: "Sam Lee. Designer.", captured_at: "2026-11-18 03:00:00" });
  // A real portfolio that jokes about robots is not a wall.
  await site("https://c-fine.dev", { page_text: `${SITE_TEXT} I am definitely not a robot.`, captured_at: "2026-11-22 03:00:00" });
  const { C } = await captureProblems(db);
  const mine = C.filter((r) => r.url.startsWith("https://c-"));
  assert.deepEqual(urls(mine), ["https://c-wall.dev", "https://c-none.dev", "https://c-short.dev"]);
  assert.equal(mine[0].reason.kind, "bot");
  assert.equal(mine[1].reason.text, "No page text was stored with this capture.");
  assert.equal(mine[2].reason.text, "Only 18 characters of page text were stored.");
});

test("group D: open same-version records, newest first, with the grade, health and review state", async () => {
  await site("https://d-worse.dev", { ai_rubric: JSON.stringify({ tier: "B", is_portfolio: true }), health: "suspect", health_reason: "HTTP 500" });
  await db.execute(`INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('t', 'https://d-worse.dev', 'signals_collapsed', 'ranked', 'remove', 0, '{}', '2026-11-22')`);
  await recordCaptureChange(db, { url: "https://d-worse.dev", prev: { facts: facts(2, { resume: true, contact: true }), chars: 3000 }, next: { facts: facts(2, {}), chars: 300 }, now: Date.parse("2026-11-22T06:00:00Z") });
  const { D } = await captureProblems(db);
  const row = D.find((r) => r.url === "https://d-worse.dev");
  assert.equal(row.reason.text, "The new capture lost its résumé and contact links and kept 300 of 3,000 characters of text.");
  assert.deepEqual(row.grade, { state: "portfolio", tier: "B" });
  assert.equal(row.health, "suspect");
  assert.equal(row.onReview, true);
  assert.ok(row.reviewId > 0);
  assert.equal(D[0].url, "https://d-worse.dev", "newest first");
});

test("plainReason: every kind of failure the re-capture saw, in plain words", () => {
  assert.equal(plainReason(`error: ${BLOCKED_PREFIX}still a gate or loader after the click-through`).kind, "cover");
  assert.equal(plainReason(`error: ${BLOCKED_PREFIX}12 words and no outbound links`).text, "Only 12 words on the page and no links to other sites.");
  assert.equal(plainReason(`error: ${MEDIA_REVIEW_REASON}`).kind, "media");
  assert.equal(plainReason("dead: renders blank").kind, "blank");
  assert.equal(plainReason("error: capture timed out after 300s").text, "Our capture timed out after 5 minutes.");
  assert.equal(plainReason("error: fetch failed: ECONNREFUSED").text, "Fetch failed: ECONNREFUSED.");
  assert.equal(plainReason(null).text, "No reason recorded.");
});

test("refreshNeedsReview: what a first capture sends to review, and a covered page; never the phone view alone", () => {
  assert.equal(refreshNeedsReview({ reason: BOT_WALL_REASON, needsReview: true }), true);
  assert.equal(refreshNeedsReview({ reason: MEDIA_REVIEW_REASON, needsReview: true }), true);
  for (const kind of ["still a gate or loader after the click-through", "still a dialog on top after the click", "still a mode picker after the click"]) {
    assert.equal(refreshNeedsReview({ reason: `${BLOCKED_PREFIX}${kind}` }), true, kind);
  }
  assert.equal(refreshNeedsReview({ reason: `${BLOCKED_PREFIX}12 words and no outbound links` }), false);
  assert.equal(refreshNeedsReview({ reason: "HTTP 503" }), false);
  assert.equal(refreshNeedsReview({ reason: `${BOT_WALL_REASON} (phone view)`, needsReview: true, phone: true }), false);
});

test("recordRefreshFailure: needsReview puts the site on the review list and leaves its capture alone", async () => {
  const url = "https://refresh-review.dev";
  await site(url, {});
  const before = (await db.execute({ sql: "SELECT shot_key, page_text, facts, status FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  await recordRefreshFailure(db, url, `error: ${BOT_WALL_REASON}`, new Date(), { needsReview: true });
  const row = (await db.execute({ sql: "SELECT shot_key, page_text, facts, status, needs_review FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  assert.equal(Number(row.needs_review), 1);
  for (const k of ["shot_key", "page_text", "facts", "status"]) assert.equal(row[k], before[k], k);
  const phone = "https://refresh-phone.dev";
  await site(phone, {});
  await recordRefreshFailure(db, phone, `error: ${BOT_WALL_REASON} (phone view)`, new Date(), { needsReview: false });
  assert.equal(Number((await db.execute({ sql: "SELECT needs_review FROM portfolios WHERE url = ?", args: [phone] })).rows[0].needs_review), 0);
});

test("the alert line: counts per group and the link, only when a count is above zero or changed", async () => {
  const zero = { A: 0, B: 0, C: 0, D: 0 };
  assert.deepEqual(captureProblemCondition(zero, null), []);
  assert.deepEqual(captureProblemCondition(zero, zero), []);
  const [c] = captureProblemCondition({ A: 70, B: 10, C: 9, D: 11 }, null, "https://portfoliorank.dev/");
  assert.equal(c.key, ALERT_KEY);
  assert.equal(c.kind, "problem");
  assert.equal(c.title, "Capture problems: A 70 · B 10 · C 9 · D 11");
  assert.match(c.detail, /A\. Refresh failed, old capture kept: 70; B\. First capture failed: 10; C\. Stored capture is bad: 9; D\. Got worse on a re-capture: 11\.\nhttps:\/\/portfoliorank\.dev\/admin\/capture-problems$/);
  assert.deepEqual(countsOfTitle(c.title), { A: 70, B: 10, C: 9, D: 11 });
  // A drop to zero is said once, as good news.
  const [done] = captureProblemCondition(zero, { A: 1, B: 0, C: 0, D: 0 });
  assert.equal(done.kind, "good");
  assert.equal(done.title, "Capture problems: none open (A 0 · B 0 · C 0 · D 0)");
  assert.match(done.detail, /\(was A 1 · B 0 · C 0 · D 0\)/);
  // From the database, against the alert as last recorded.
  const [now] = await captureProblemConditions(db, { siteUrl: "https://portfoliorank.dev" });
  assert.equal(now.kind, "problem");
});
