// The admin's Capture problems list (lib/capture-problems.mjs): each group's
// rule on a migrated database, the record a worse re-capture writes (facts of
// the same version compared, a version change labelled as the measuring
// code), the plain-words reasons, the nightly alert (emailed only when a
// count rose since the last email), and the review row a blocked refresh
// writes (pipeline/capture.mjs refreshNeedsReview, lib/reviews/door.mjs
// blockedRefreshReview), which a later health check leaves in place; the
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
  captureProblemConditionsOrLog,
  captureProblems,
  countsOfTitle,
  plainReason,
  recordCaptureChange,
} from "../lib/capture-problems.mjs";
import { recordRefreshFailure, refreshNeedsReview } from "../pipeline/capture.mjs";
import { BLOCKED_PREFIX, BOT_WALL_REASON, MEDIA_REVIEW_REASON, SHOWS_SITE_REASON } from "../pipeline/capture-blocked.mjs";
import { closeBlockedRefreshReviews } from "../lib/reviews/door.mjs";
import { listReviews, decideReviews } from "../lib/reviews/store.mjs";
import { reconcileAlerts } from "../pipeline/alerts.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";

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
  // Only listed, live sites: a delisted one, one that is no longer live and a row with no site are left out.
  await site("https://a-delisted.dev", { delisted_at: "2026-11-21" });
  await site("https://a-pending.dev", { status: "pending" });
  for (const url of ["https://a-delisted.dev", "https://a-pending.dev", "https://a-gone.dev"]) await recordRefreshFailure(db, url, "error: HTTP 503", new Date("2026-11-22T06:00:00Z"));
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
  let { B } = await captureProblems(db);
  assert.deepEqual(urls(B), ["https://b-wall.dev", "https://b-dead.dev"]);
  // The needs_review flag alone is not the review list (the health check rewrites it); an open row is.
  assert.equal(B[0].onReview, false);
  await db.execute(`INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('bot-wall', 'https://b-wall.dev', 'bot_wall', 'hidden', 'review', 0, '{}', '2026-11-22')`);
  ({ B } = await captureProblems(db));
  assert.equal(B[0].onReview, true);
  assert.ok(B[0].reviewId > 0);
  assert.equal(B[0].reason.text, "A bot or security check stood in for the site.");
  assert.equal(B[1].attempts, 3);
  assert.equal(B[1].retryAt, "2026-11-25T04:00:00.000Z");
  assert.equal(B[1].capturedAt, null);
});

test("group C: a stored bot check, no words or under 200 characters; a good long capture and an unmeasured one are not", async () => {
  const before = (await captureProblems(db)).unmeasured;
  await site("https://c-wall.dev", { page_text: "Just a moment...\nVerifying you are human. This may take a few seconds.", facts: facts(2, { internal_pages: 0 }), captured_at: "2026-11-21 03:00:00" });
  await site("https://c-empty.dev", { page_text: "  ", captured_at: "2026-11-19 03:00:00" });
  await site("https://c-short.dev", { page_text: "Sam Lee. Designer.", captured_at: "2026-11-18 03:00:00" });
  // Captured before captures stored page text (#57): never measured, so not a bad capture; counted apart.
  await site("https://c-unmeasured.dev", { page_text: null, captured_at: "2026-11-01 03:00:00" });
  // A real portfolio that jokes about robots is not a wall.
  await site("https://c-fine.dev", { page_text: `${SITE_TEXT} I am definitely not a robot.`, captured_at: "2026-11-22 03:00:00" });
  const { C, unmeasured } = await captureProblems(db);
  const mine = C.filter((r) => r.url.startsWith("https://c-"));
  assert.deepEqual(urls(mine), ["https://c-wall.dev", "https://c-empty.dev", "https://c-short.dev"]);
  assert.equal(mine[0].reason.kind, "bot");
  assert.equal(mine[1].reason.text, "The capture read no text on the page.");
  assert.equal(mine[2].reason.text, "Only 18 characters of page text were stored.");
  assert.equal(unmeasured, before + 1);
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

test("group D: a delisted site's open record is not listed", async () => {
  await site("https://d-delisted.dev", { delisted_at: "2026-11-21" });
  await recordCaptureChange(db, { url: "https://d-delisted.dev", prev: { facts: facts(2, { github: true }), chars: 3000 }, next: { facts: facts(2, {}), chars: 3000 }, now: Date.parse("2026-11-22T07:00:00Z") });
  const { D } = await captureProblems(db);
  assert.ok(!urls(D).includes("https://d-delisted.dev"));
});

test("the page's open count counts a site in two groups once", async () => {
  // A site whose re-capture failed (A) and whose stored capture is short (C).
  await site("https://two-groups.dev", { page_text: "Too short.", captured_at: "2026-11-02 03:00:00" });
  await recordRefreshFailure(db, "https://two-groups.dev", "error: HTTP 503", new Date("2026-11-01T04:00:00Z"));
  const p = await captureProblems(db);
  assert.ok(urls(p.A).includes("https://two-groups.dev") && urls(p.C).includes("https://two-groups.dev"));
  const rows = [...p.A, ...p.B, ...p.C, ...p.D];
  assert.equal(p.sites, new Set(urls(rows)).size);
  assert.ok(p.sites < rows.length);
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

test("refreshNeedsReview: only a bot check or a dialog still covering the page; never the phone view alone", () => {
  assert.equal(refreshNeedsReview({ reason: BOT_WALL_REASON }), true);
  assert.equal(refreshNeedsReview({ reason: `${BLOCKED_PREFIX}still a dialog on top after the click` }), true);
  // What the owner did not ask for stays a refresh failure (group A lists it with its reason).
  for (const reason of [
    `${BLOCKED_PREFIX}still a gate or loader after the click-through`,
    `${BLOCKED_PREFIX}still a mode picker after the click`,
    MEDIA_REVIEW_REASON,
    `${SHOWS_SITE_REASON} (HTTP 403)`,
    `${BLOCKED_PREFIX}12 words and no outbound links`,
    "HTTP 503",
  ]) {
    assert.equal(refreshNeedsReview({ reason }), false, reason);
  }
  assert.equal(refreshNeedsReview({ reason: `${BOT_WALL_REASON} (phone view)`, phone: true }), false);
});

/** The pending review rows of a site. */
const pendingOf = async (d, url) => (await d.execute({ sql: "SELECT * FROM status_reviews WHERE url = ? AND status = 'pending' ORDER BY id", args: [url] })).rows;

test("a blocked refresh writes one review row for a listed, graded site and leaves its capture alone", async () => {
  const url = "https://refresh-review.dev";
  await site(url, { ai_rubric: JSON.stringify({ tier: "B", is_portfolio: true }), captured_at: "2026-11-20 03:00:00" });
  const before = (await db.execute({ sql: "SELECT shot_key, page_text, facts, status, ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  await recordRefreshFailure(db, url, `error: ${BOT_WALL_REASON}`, new Date("2026-11-22T04:00:00Z"), { needsReview: true });
  const row = (await db.execute({ sql: "SELECT shot_key, page_text, facts, status, ai_rubric, needs_review FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  for (const k of ["shot_key", "page_text", "facts", "status", "ai_rubric"]) assert.equal(row[k], before[k], k);
  let rows = await pendingOf(db, url);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grp, "bot_wall");
  assert.equal(rows[0].proposed, "review");
  assert.equal(rows[0].current, "ranked");
  assert.equal(rows[0].shot_key, before.shot_key, "the review page shows the stored capture");
  assert.match(String(rows[0].reason), /^A nightly re-capture of this listed site met a bot or security check instead of the site\. The stored capture from 2026-11-20 is kept, so the site stays listed with its grade/);
  assert.doesNotMatch(String(rows[0].reason), /never|no grader/);
  // It is on the review page and on the Capture problems page as such.
  assert.ok((await listReviews(db)).pending.some((r) => r.url === url));
  assert.equal((await captureProblems(db)).A.find((r) => r.url === url)?.onReview, true);
  // The next blocked refresh adds nothing while the row is open.
  await recordRefreshFailure(db, url, `error: ${BOT_WALL_REASON}`, new Date("2026-11-23T04:00:00Z"), { needsReview: true });
  assert.equal((await pendingOf(db, url)).length, 1);
  // Mark checked: decided. Another block of the same stored capture is the same episode: no new row.
  const [decided] = await decideReviews(db, { ids: [Number(rows[0].id)], action: "confirm", actor: "admin:test", onFeed: () => true, now: new Date("2026-11-23T05:00:00Z") });
  assert.equal(decided.ok, true);
  await recordRefreshFailure(db, url, `error: ${BOT_WALL_REASON}`, new Date("2026-11-24T04:00:00Z"), { needsReview: true });
  assert.equal((await pendingOf(db, url)).length, 0);
  // A later capture got through (captured_at moves), then a re-capture is blocked again: a new episode, a new row.
  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-25 03:00:00' WHERE url = ?", args: [url] });
  await recordRefreshFailure(db, url, `error: ${BOT_WALL_REASON}`, new Date("2026-11-26T04:00:00Z"), { needsReview: true });
  rows = await pendingOf(db, url);
  assert.equal(rows.length, 1);
  // And once a capture gets through, that row closes by itself.
  assert.equal(await closeBlockedRefreshReviews(db, url, { now: new Date("2026-11-27T04:00:00Z") }), 1);
  assert.equal((await pendingOf(db, url)).length, 0);
  assert.equal((await captureProblems(db)).A.find((r) => r.url === url)?.onReview, false);
});

test("a blocked refresh: a covering dialog is worded as such; phone-only, delisted and already-open sites get no new row", async () => {
  const dialog = "https://refresh-dialog.dev";
  await site(dialog, {});
  await recordRefreshFailure(db, dialog, `error: ${BLOCKED_PREFIX}still a dialog on top after the click`, new Date(), { needsReview: true });
  const [row] = await pendingOf(db, dialog);
  assert.match(String(row.reason), /was still covered by a dialog after we tried to close it\. The stored capture from 2026-11-20 is kept, so the site stays listed and nothing about it changes/);
  assert.equal(row.current, "listed", "not graded yet: listed, not ranked");
  const phone = "https://refresh-phone.dev";
  await site(phone, {});
  await recordRefreshFailure(db, phone, `error: ${BOT_WALL_REASON} (phone view)`, new Date(), { needsReview: false });
  assert.equal(Number((await db.execute({ sql: "SELECT needs_review FROM portfolios WHERE url = ?", args: [phone] })).rows[0].needs_review), 0);
  assert.equal((await pendingOf(db, phone)).length, 0);
  const delisted = "https://refresh-delisted.dev";
  await site(delisted, { delisted_at: "2026-11-21" });
  await recordRefreshFailure(db, delisted, `error: ${BOT_WALL_REASON}`, new Date(), { needsReview: true });
  assert.equal((await pendingOf(db, delisted)).length, 0);
  // One open case per site: a site already waiting on another row gets no second one.
  const open = "https://refresh-open.dev";
  await site(open, {});
  await db.execute({ sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('t', ?, 'signals_collapsed', 'ranked', 'remove', 0, '{}', '2026-11-22')`, args: [open] });
  await recordRefreshFailure(db, open, `error: ${BOT_WALL_REASON}`, new Date(), { needsReview: true });
  const rows = await pendingOf(db, open);
  assert.deepEqual(rows.map((r) => r.grp), ["signals_collapsed"]);
});

test("a weekly health check after a blocked refresh leaves the site on the review list", async () => {
  // Its own database: the health check reads the whole feed it is given.
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-problems-health-"));
  const hdb = createClient({ url: `file:${path.join(hdir, "db.sqlite")}` });
  try {
    await migrate(hdb);
    const url = "https://health-after-block.dev";
    await hdb.execute({
      sql: `INSERT INTO portfolios (url, name, status, reason, shot_key, captured_at, page_text, facts, ai_rubric, health)
            VALUES (?, 'Jane Doe', 'live', '', 'k0k0k0k0k0k0k0k0', '2026-11-20 03:00:00', ?, ?, ?, 'live')`,
      args: [url, SITE_TEXT, facts(2, {}), JSON.stringify({ tier: "B", is_portfolio: true })],
    });
    await recordRefreshFailure(hdb, url, `error: ${BOT_WALL_REASON}`, new Date("2026-11-22T04:00:00Z"), { needsReview: true });
    assert.equal(Number((await hdb.execute({ sql: "SELECT needs_review FROM portfolios WHERE url = ?", args: [url] })).rows[0].needs_review), 1);
    // The plain fetch gets the site with good signals, so the check writes needs_review = 0.
    const page = "<html><head><title>Jane Doe - Developer</title></head><body><h1>Jane Doe</h1><p>Hi, I'm Jane Doe. I build things for the web. <a href='https://github.com/x'>GitHub</a> Projects, resume, contact me.</p></body></html>";
    const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => page });
    await runHealthCheck({ db: hdb, feed: [{ name: "Jane Doe", url }], fetchImpl, now: new Date("2026-11-23T00:00:00Z"), log: () => {}, alerts: false, doorLimit: 0 });
    assert.equal(Number((await hdb.execute({ sql: "SELECT needs_review FROM portfolios WHERE url = ?", args: [url] })).rows[0].needs_review), 0, "the health check rewrote the flag");
    // The row is the record: still pending, and the page still says so.
    assert.equal((await pendingOf(hdb, url)).length, 1);
    const { A } = await captureProblems(hdb);
    assert.equal(A.find((r) => r.url === url)?.onReview, true);
  } finally {
    hdb.close();
    fs.rmSync(hdir, { recursive: true, force: true });
  }
});

test("the alert condition: counts per group and the link while any is open, quiet unless a count rose since the last email", () => {
  const zero = { A: 0, B: 0, C: 0, D: 0 };
  assert.deepEqual(captureProblemCondition(zero, null), []);
  assert.deepEqual(captureProblemCondition(zero, { A: 5, B: 0, C: 0, D: 0 }), [], "all zero: nothing holds, the alert clears");
  const [c] = captureProblemCondition({ A: 70, B: 10, C: 9, D: 11 }, null, "https://portfoliorank.dev/");
  assert.equal(c.key, ALERT_KEY);
  assert.equal(c.kind, "problem");
  assert.equal(c.quiet, false, "never emailed before: it goes out");
  assert.equal(c.repeats, false);
  assert.equal(c.title, "Capture problems: A 70 · B 10 · C 9 · D 11");
  assert.match(c.detail, /^A\. Refresh failed, old capture kept: 70; B\. First capture failed: 10; C\. Stored capture is bad: 9; D\. Got worse on a re-capture: 11\.\nhttps:\/\/portfoliorank\.dev\/admin\/capture-problems$/);
  assert.deepEqual(countsOfTitle(c.title), { A: 70, B: 10, C: 9, D: 11 });
  const told = { A: 70, B: 10, C: 9, D: 11 };
  assert.equal(captureProblemCondition(told, told)[0].quiet, true, "the same counts: quiet");
  assert.equal(captureProblemCondition({ A: 40, B: 10, C: 9, D: 11 }, told)[0].quiet, true, "a fall: quiet");
  const [up] = captureProblemCondition({ A: 60, B: 10, C: 9, D: 12 }, told);
  assert.equal(up.quiet, false, "D rose, even though A fell");
  assert.match(up.detail, /Up since the last email: D 11 to 12\./);
});

test("the alert end to end: one email for 100 open problems, none the next nights, one when a count rises", async () => {
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-problems-alert-"));
  const adb = createClient({ url: `file:${path.join(adir, "db.sqlite")}` });
  try {
    await migrate(adb);
    for (let i = 0; i < 100; i++) {
      const url = `https://a${i}.dev`;
      await adb.execute({ sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, page_text) VALUES (?, 'x', 'live', '', 'k', ?)", args: [url, SITE_TEXT] });
      await recordRefreshFailure(adb, url, "error: HTTP 503", new Date("2026-11-22T04:00:00Z"));
    }
    const sent = [];
    const email = { send: async (m) => void sent.push(m) };
    const night = async (day) => {
      const { conditions } = await captureProblemConditionsOrLog(adb, { siteUrl: "https://portfoliorank.dev" });
      return reconcileAlerts(adb, { conditions, now: new Date(`${day}T05:00:00Z`), email, to: "owner@example.com" });
    };
    let r = await night("2026-11-23");
    assert.deepEqual(r.sent, [ALERT_KEY]);
    assert.match(sent[0].subject, /Capture problems: A 100 · B 0 · C 0 · D 0/);
    assert.match(sent[0].text, /This email comes again only when it gets worse\./);
    for (const day of ["2026-11-24", "2026-11-25"]) {
      r = await night(day);
      assert.deepEqual(r.sent, [], `no email on ${day}`);
      assert.deepEqual(r.quiet, [ALERT_KEY]);
      assert.deepEqual(r.cleared, [], "still open for the admin");
    }
    assert.equal(sent.length, 1);
    // A new problem in group B: one email the next night.
    await adb.execute({ sql: "INSERT INTO portfolios (url, name, status, reason) VALUES ('https://b-new.dev', 'x', 'error', 'HTTP 500')" });
    r = await night("2026-11-26");
    assert.deepEqual(r.sent, [ALERT_KEY]);
    assert.match(sent[1].text, /Up since the last email: B 0 to 1\./);
    r = await night("2026-11-27");
    assert.deepEqual(r.sent, []);
  } finally {
    adb.close();
    fs.rmSync(adir, { recursive: true, force: true });
  }
});

test("the alert: a failed read gives no conditions and says so, for the night to leave the alert as it was", async () => {
  const errors = [];
  const broken = { execute: async () => Promise.reject(new Error("D1 is down")) };
  const r = await captureProblemConditionsOrLog(broken, { log: (e) => errors.push(e) });
  assert.deepEqual(r, { conditions: [], failed: true });
  assert.deepEqual(errors, ["D1 is down"]);
  // On the shared database it reads the counts.
  const ok = await captureProblemConditionsOrLog(db, { siteUrl: "https://portfoliorank.dev" });
  assert.equal(ok.failed, false);
  assert.equal(ok.conditions[0].kind, "problem");
  assert.equal(ok.conditions[0].quiet, false);
  assert.deepEqual(ok.conditions, await captureProblemConditions(db, { siteUrl: "https://portfoliorank.dev" }));
});
