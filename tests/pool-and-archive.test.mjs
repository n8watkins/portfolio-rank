// The temporary pool and the archive (owner, 2026-11-23: "if something is
// failing a health check, it doesn't go to review by me ... it gets
// automatically disabled and goes to a pool and that pool gets periodically
// checked. And after 90 days, it gets put into the archived section ... once a
// month to see if they pass any health checks"). Every rule in both
// directions, offline: a throwaway database, a simulated clock, stand-ins for
// the plain request and the browser (pipeline/not-working.mjs,
// pipeline/health.mjs, pipeline/exclusions.mjs, lib/reviews/door.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as health from "../pipeline/health.mjs";
import * as pool from "../pipeline/not-working.mjs";
import { runRecheck } from "../pipeline/recheck.mjs";
import { planExclusions, weeklyExport } from "../pipeline/exclusions.mjs";
import { LEFT_LIST, buildFeed } from "../pipeline/build-feed.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { addressNotPortfolio, finalAddressOf, junkCheck } from "../pipeline/junk-rules.mjs";
import { addressBrakeConditions } from "../pipeline/alerts.mjs";
import { ensureTierSchema } from "../lib/tiers-db.mjs";
import { decideReviews, ensureReviewSchema, undoReviews } from "../lib/reviews/store.mjs";
import { ADDRESS_AUTO_PER_NIGHT, STALE_ACTOR, addressBrake, closeStaleReviews, doorDecision, syncReviewRows } from "../lib/reviews/door.mjs";
import { healthPool } from "../lib/admin/health-pool.mjs";
import { PORTFOLIO_HTML, T0, answer, col, freshDb, hidden, reviewsOf, site } from "./helpers/door-night.mjs";

const quiet = () => {};
const H = 3600000;
const D = 86400000;
const at = (ms) => new Date(ms);
const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });
const goodPage = (url) => ({ status: 200, finalUrl: `${url}/`, title: "Ann Lee | Engineer", text: "Ann Lee builds web apps. Projects, about and contact.", media: false, html: PORTFOLIO_HTML });
const PARKED = "<html><head><title>This domain is for sale</title></head><body>Buy this domain. This domain is for sale.</body></html>";

/** Sites answering as the test sets: "ok", "parked" (a for-sale page), "paused" (HTTP 402), "unsure" (the check cannot tell). */
function world() {
  const mode = new Map();
  const of = (u) => [...mode].find(([url]) => u.startsWith(url))?.[1] ?? "ok";
  const fetchImpl = async (u) => {
    const m = of(u);
    if (m === "paused") return response(402, "This deployment is temporarily paused", u);
    if (m === "parked") return response(200, PARKED, u);
    if (m === "unsure") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    return response(200, PORTFOLIO_HTML, u);
  };
  const render = async (u) => {
    const m = of(u);
    if (m === "paused") return { status: 402, finalUrl: `${u}/`, title: "", text: "This deployment is temporarily paused", media: false, html: "" };
    if (m === "parked") return { status: 200, finalUrl: `${u}/`, title: "This domain is for sale", text: "Buy this domain. This domain is for sale.", media: false, html: PARKED };
    if (m === "unsure") throw new Error("page.goto: Timeout 30000ms exceeded.");
    return goodPage(u);
  };
  return { mode, fetchImpl, render };
}

const fillers = Array.from({ length: 30 }, (_, i) => ({ url: `https://filler-${i}.dev`, name: "Ann Lee" }));

async function setup(urls) {
  const { db } = await freshDb();
  for (const f of fillers) await site(db, f.url, { rubric: answer(true) });
  for (const u of urls) await site(db, u, { rubric: answer(true) });
  const feed = [...urls.map((url) => ({ url, name: "Ann Lee" })), ...fillers];
  const w = world();
  const nightly = (now) => health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  const hourly = (now) => runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  return { db, feed, w, nightly, hourly };
}

const reviewCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM status_reviews")).rows[0]?.n ?? 0);

// ---------------------------------------------------------------------------
// The ladder, for a page with the wrong thing (a parked domain)

test("a parked site that fails once and recovers is never hidden, and nothing goes to the owner", async () => {
  const url = "https://parked-once.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await ensureReviewSchema(db);
  await nightly(T0);
  w.mode.set(url, "parked");
  await nightly(T0 + D);
  assert.equal(await col(db, url, "health"), "suspect");
  assert.equal(await hidden(db, url), false, "failing: still shown");
  w.mode.set(url, "ok");
  const s = await hourly(T0 + D + H);
  assert.deepEqual(s.returned.map((r) => r.url), [url]);
  assert.equal(await col(db, url, "health"), "live");
  assert.equal(await hidden(db, url), false);
  assert.equal(await reviewCount(db), 0, "no row in the owner's review queue");
});

test("a parked site that fails on two days is hidden in the pool; a pass there brings it back with its grade, votes and rating", async () => {
  const url = "https://parked-twice.example";
  const { db, w, nightly, hourly } = await setup([url]);
  await ensureReviewSchema(db);
  await ensureTierSchema(db);
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, votes, member, seeded, tier) VALUES (?, 31.5, 4.2, 18.9, 40, 17, 1, 1, 'A')", args: [url] });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, rater_id) VALUES (?, ?, 'r1'), (?, ?, 'r2')", args: [url, fillers[0].url, fillers[1].url, url] });
  const grade = await col(db, url, "ai_rubric");
  await nightly(T0);
  w.mode.set(url, "parked");
  const F = T0 + D;
  await nightly(F);
  // Two failures on the same day: still shown (one bad night never hides a site).
  await hourly(F + H);
  assert.equal(await hidden(db, url), false);
  await hourly(F + D);
  assert.equal(await col(db, url, "health"), "down");
  assert.equal(await hidden(db, url), true, "hidden in the temporary pool");
  assert.equal(await reviewCount(db), 0, "still nothing for the owner");
  // Its admin page lists it: why, since when, next check, the day it would be archived.
  const page = await healthPool(db, { excluded: [], now: at(F + D + H) });
  assert.deepEqual(page.pool.map((p) => p.url), [url]);
  assert.match(page.pool[0].reason, /parking|sale|parked/i);
  assert.equal(page.pool[0].since, at(F + D).toISOString());
  assert.ok(page.pool[0].next > at(F + D).toISOString());
  assert.equal(page.pool[0].archiveOn, at(F + D + 90 * D).toISOString());
  // The domain is back: a pass in the pool restores it exactly.
  w.mode.set(url, "ok");
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [at(F + 5 * D).toISOString(), url] });
  await hourly(F + 5 * D);
  assert.equal(await col(db, url, "health"), "live");
  assert.equal(await hidden(db, url), false);
  assert.equal(await col(db, url, "ai_rubric"), grade, "the grade is untouched");
  assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE winner = ? OR loser = ?", args: [url, url] })).rows[0].n), 2, "the votes are kept");
  const r = (await db.execute({ sql: "SELECT mu, sigma, votes FROM tier_ratings WHERE url = ?", args: [url] })).rows[0];
  assert.deepEqual([Number(r.mu), Number(r.sigma), Number(r.votes)], [31.5, 4.2, 17], "the rating and its votes are kept");
  const back = await healthPool(db, { excluded: [], now: at(F + 5 * D + H) });
  assert.deepEqual(back.returned.map((x) => [x.url, x.from, x.hidden]), [[url, "pool", true]]);
  assert.deepEqual(back.pool, []);
});

test("an inconclusive check never fails a site, and a run that could not tell for too many sites records nothing", async () => {
  const url = "https://unsure.example";
  const { db, feed, w, nightly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "unsure");
  for (const d of [1, 2, 3]) await nightly(T0 + d * D);
  assert.equal(await col(db, url, "health"), "live");
  assert.equal((await db.execute({ sql: "SELECT pool_stage FROM health_marks WHERE url = ?", args: [url] })).rows[0]?.pool_stage ?? null, null);
  // Most of the list unclear at once: the runner, not the sites.
  for (const f of feed) w.mode.set(f.url, "unsure");
  const s = await nightly(T0 + 4 * D);
  assert.equal(s.aborted, true);
});

test("a duplicate stays a duplicate on the hourly re-check, though its original is not in that run", async () => {
  const original = "https://ann-lee.example";
  const copy = "https://www.ann-lee.example/";
  const { db, nightly, hourly } = await setup([original, copy]);
  await nightly(T0);
  assert.equal(await col(db, copy, "health_reason"), `duplicate of ${original}`);
  await hourly(T0 + H);
  assert.equal(await col(db, copy, "health"), "suspect", "still failing as a duplicate");
  await hourly(T0 + D);
  assert.equal(await col(db, copy, "health"), "down", "hidden: the original stays listed");
  assert.equal(await hidden(db, original), false);
});

// ---------------------------------------------------------------------------
// The listed address fails, the site answers at its own www or https address (http://gianlucafiore.it)

test("a listed address that fails while the site answers at its own https and www address is not a failure; another domain or a dead final address is", async () => {
  const listed = "http://rescue.example";
  const final = "https://www.rescue.example/";
  const bothDead = "http://both-dead.example";
  const moved = "http://moved-away.example";
  const { db, w, nightly } = await setup([listed, bothDead, moved]);
  await nightly(T0);
  // Earlier good reads ended at these addresses.
  await db.execute({ sql: "UPDATE portfolios SET final_url = ? WHERE url = ?", args: [final, listed] });
  await db.execute({ sql: "UPDATE portfolios SET final_url = 'https://www.both-dead.example/' WHERE url = ?", args: [bothDead] });
  await db.execute({ sql: "UPDATE portfolios SET final_url = 'https://another-domain.example/' WHERE url = ?", args: [moved] });
  // The listed addresses now answer from a dead server; the final addresses of the first site work.
  w.mode.set(listed, "paused");
  w.mode.set(bothDead, "paused");
  w.mode.set("https://www.both-dead.example", "paused");
  w.mode.set(moved, "paused");
  const s = await nightly(T0 + D);
  assert.equal(await col(db, listed, "health"), "live", "the site answers at its own address: passes");
  assert.deepEqual(s.answersElsewhere.map((a) => [a.url, a.at]), [[listed, final]]);
  assert.equal((await db.execute({ sql: "SELECT answers_at FROM health_marks WHERE url = ?", args: [listed] })).rows[0].answers_at, final);
  assert.equal(await col(db, bothDead, "health"), "suspect", "its final address is dead too: a failure as before");
  assert.equal(await col(db, moved, "health"), "suspect", "another domain is never tried");
  assert.match(health.healthSummary(s), /Listed address unreliable/);
  // The admin page says so.
  const page = await healthPool(db, { excluded: [], now: at(T0 + D + H) });
  assert.deepEqual(page.elsewhere.map((e) => [e.url, e.at]), [[listed, final]]);
  // The failed reads never wrote a final address.
  assert.equal(await col(db, bothDead, "final_url"), "https://www.both-dead.example/");
  // The listed address works again on its own: the note clears.
  w.mode.set(listed, "ok");
  await nightly(T0 + 2 * D);
  assert.equal((await db.execute({ sql: "SELECT answers_at FROM health_marks WHERE url = ?", args: [listed] })).rows[0].answers_at, null);
  // The rule itself.
  assert.equal(health.sameSiteAddress("http://gianlucafiore.it", { final_url: "https://www.gianlucafiore.it/" }), "https://www.gianlucafiore.it/");
  assert.equal(health.sameSiteAddress("http://gianlucafiore.it", { final_url: "http://gianlucafiore.it/" }), null, "the same address");
  assert.equal(health.sameSiteAddress("http://gianlucafiore.it", { final_url: "https://blog.gianlucafiore.it/" }), null, "another host");
  assert.equal(health.sameSiteAddress("http://gianlucafiore.it", { final_url: "https://github.com/x" }), null);
  assert.equal(health.sameSiteAddress("http://gianlucafiore.it", { final_url: "http://gianlucafiore.it/", facts_final_url: "https://www.gianlucafiore.it/" }), "https://www.gianlucafiore.it/");
});

// ---------------------------------------------------------------------------
// The archive

test("90 days in the pool: archived; the archive check brings a working site back and never a not-a-portfolio removal", async () => {
  const url = "https://parked-long.example";
  const { db, feed, w, nightly, hourly } = await setup([url]);
  await nightly(T0);
  w.mode.set(url, "parked");
  await nightly(T0 + D);
  await hourly(T0 + D + H);
  await hourly(T0 + 2 * D);
  const S = T0 + 2 * D;
  assert.deepEqual((await planExclusions({ db, excluded: [], feed, now: at(S + 89 * D) })).added, [], "not before day 90");
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [at(S + 90 * D).toISOString(), url] });
  await hourly(S + 90 * D);
  const plan = await planExclusions({ db, excluded: [], feed, now: at(S + 90 * D) });
  assert.deepEqual(plan.added.map((a) => [a.url, a.kind]), [[url, "down"]]);
  const archived = plan.added[0];
  assert.equal(pool.archiveCheckDue(archived), new Date(Date.parse(`${archived.removed}T00:00:00Z`) + 7 * D).toISOString().slice(0, 10), "first check a week after archiving");

  // A month later, the archive check: the parked site works again; a not-a-portfolio removal and an owner's
  // request are never checked. The community list has dropped the site meanwhile.
  const np = { url: "https://not-a-portfolio.example", name: "X", kind: "not_portfolio", reason: "AI grading says this is not a portfolio", removed: archived.removed };
  const owner = { url: "https://asked-off.example", name: "Y", kind: "owner_request", reason: "owner request", removed: archived.removed };
  const excluded = [archived, np, owner];
  const later = at(Date.parse(`${archived.removed}T12:00:00Z`) + 31 * D);
  const checked = [];
  const answers = async (u) => (checked.push(u), u === url);
  const ex = await weeklyExport({ db, excluded, feed: plan.feed, additions: [], answers, now: later });
  assert.deepEqual(checked, [url], "only the archive is checked");
  assert.deepEqual(ex.plan.back, [url]);
  assert.deepEqual(ex.files.excluded.map((e) => e.url), [np.url, owner.url]);
  assert.deepEqual(ex.files.additions.map((a) => [a.url, a.source]), [[url, LEFT_LIST]], "recorded so our list keeps it");
  // The next sync lists it again although the community list no longer has it.
  const built = buildFeed({ entries: fillers, excluded: ex.files.excluded, additions: ex.files.additions, current: plan.feed });
  assert.ok(built.feed.some((p) => p.url === url));
  // The owner's page shows what came back from the archive.
  const page = await healthPool(db, { excluded: ex.files.excluded, now: later });
  assert.deepEqual(page.returned.map((r) => [r.url, r.from]), [[url, "archive"]]);
  assert.deepEqual(page.archive, [], "not-a-portfolio and owner removals are not the archive");
  // Applied again the next night (until it lands): nothing is recorded twice.
  const again = await weeklyExport({ db, excluded, feed: plan.feed, additions: ex.files.additions, answers, now: at(later.getTime() + D) });
  assert.equal(again.files.additions.length, 1);
});

test("the archive check: an old 91-day 'dead' entry is checked within a month; one that still fails waits for its next check", async () => {
  const e = { url: "https://gone.example", kind: "dead", reason: "The domain no longer resolves", removed: "2026-11-13", recheck_after: "2027-02-13", decided_by: "health:dns" };
  assert.equal(pool.archiveCheckDue(e), "2026-12-13");
  assert.equal(pool.archiveCheckDue({ ...e, decided_by: "owner" }), null, "a removal the owner decided is never brought back");
  assert.equal(pool.archiveCheckDue({ ...e, kind: "duplicate" }), null);
  assert.equal(pool.nextArchiveCheck("2026-11-13", "2026-12-13"), "2027-01-12");
});

// ---------------------------------------------------------------------------
// Bot walls

test("a bot wall is asked about once: decided, it holds; the owner is asked again only after a real failure and a return", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const url = "https://walled-once.example";
  await site(db, url, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  let s = await syncReviewRows(db, { now: at(T0) });
  assert.deepEqual(s.botWall, [url]);
  const [row] = await reviewsOf(db, url);
  await decideReviews(db, { ids: [Number(row.id)], action: "confirm", actor: "admin:owner", onFeed: () => true, now: at(T0 + H) });
  for (const t of [T0 + D, T0 + 2 * D]) assert.deepEqual((await syncReviewRows(db, { now: at(t) })).botWall, [], "his Mark checked holds");
  // A real failure: on the ladder, no row while it fails.
  await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_reason = 'HTTP 404' WHERE url = ?", args: [url] });
  assert.deepEqual((await syncReviewRows(db, { now: at(T0 + 3 * D) })).botWall, [], "a failing site is the pool's, not the owner's");
  // It came back: asked once more.
  await db.execute({ sql: "UPDATE portfolios SET health = 'live', health_reason = '' WHERE url = ?", args: [url] });
  await db.execute({ sql: "INSERT INTO health_returns (url, at, from_where) VALUES (?, ?, 'pool')", args: [url, at(T0 + 4 * D).toISOString()] });
  s = await syncReviewRows(db, { now: at(T0 + 5 * D) });
  assert.deepEqual(s.botWall, [url]);
  assert.deepEqual((await syncReviewRows(db, { now: at(T0 + 6 * D) })).botWall, [], "and only once");
});

test("bot-wall and blocked re-capture rows close by themselves once a capture got through", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const walled = "https://wall-then-through.example";
  const refreshed = "https://refresh-then-through.example";
  const still = "https://still-walled.example";
  await site(db, walled, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  await site(db, still, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  await site(db, refreshed);
  await syncReviewRows(db, { now: at(T0) });
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, signals, status, created_at)
          VALUES ('recapture-blocked:x', ?, 'recapture_blocked', 'ranked', 'review', 0, '{}', '{"capture":{"failed":"a bot check on re-capture","refresh":true}}', 'pending', ?)`,
    args: [refreshed, at(T0).toISOString()],
  });
  // Captures get through for two of them, after the rows were written.
  await db.execute({ sql: "UPDATE portfolios SET status = 'live', reason = '', shot_key = 'kx', captured_at = '2026-11-18 03:00:00' WHERE url = ?", args: [walled] });
  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-18 03:00:00' WHERE url = ?", args: [refreshed] });
  const closed = await closeStaleReviews(db, { now: at(T0 + 2 * D) });
  assert.deepEqual([closed.bot_wall, closed.recapture_blocked, closed.signals_collapsed], [1, 1, 0]);
  for (const u of [walled, refreshed]) {
    const [r] = await reviewsOf(db, u);
    assert.equal(String(r.status), "closed", u);
    assert.equal(String(r.decided_by), STALE_ACTOR);
    assert.ok(JSON.parse(String(r.applied)).closed, "the reason is recorded");
  }
  assert.equal(Number(await col(db, walled, "needs_review")), 0, "the wall's mark is answered");
  assert.equal(String((await reviewsOf(db, still))[0].status), "pending", "a site still behind its wall keeps its row");
});

// ---------------------------------------------------------------------------
// The one-time migration of the review queue, on production's 46 rows of 2026-11-23

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "review-queue-2026-11-23.json"), "utf8"));

async function seedQueue() {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  for (const { review: r, site: s } of FIXTURE) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO portfolios (url, name, status, reason, shot_key, captured_at, health, health_reason, health_checked_at, needs_review, signals, ai_rubric)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [s.url, s.name, s.status, s.reason, s.shot_key, s.captured_at, s.health, s.health_reason, s.health_checked_at, Number(s.needs_review ?? 0), JSON.stringify({ score: s.signals_score }), s.graded_portfolio ? JSON.stringify(answer(true)) : null],
    });
    await db.execute({
      sql: `INSERT INTO status_reviews (id, batch, url, grp, current, proposed, agreed, verdicts, signals, status, created_at, undone_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`,
      args: [r.id, r.batch, r.url, r.grp, r.current, r.proposed, r.agreed, r.status, r.created_at, r.undone_at],
    });
  }
  return db;
}

test("the migration on production's 46 pending rows: 42 low-signal and 2 stale bot-wall rows close, the 2 real bot walls wait; twice is the same as once", async () => {
  assert.equal(FIXTURE.length, 46);
  assert.ok(!JSON.stringify(FIXTURE).includes("@"), "no email addresses in the fixture");
  const db = await seedQueue();
  // A decided row and an undone row: never touched.
  await db.execute({ sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, created_at, decided_at, decided_by) VALUES ('old', 'https://dustinbrett.com', 'signals_collapsed', 'ranked', 'remove', 0, '{}', 'rejected', '2026-11-10', '2026-11-11', 'admin:owner')" });
  await db.execute({ sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, created_at, undone_at) VALUES ('undone', 'https://lamine.cc', 'signals_collapsed', 'ranked', 'remove', 0, '{}', 'pending', '2026-11-10', '2026-11-12')" });
  const dry = await closeStaleReviews(db, { now: at(T0), dryRun: true });
  assert.deepEqual([dry.signals_collapsed, dry.bot_wall, dry.recapture_blocked], [42, 2, 0]);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM status_reviews WHERE status = 'pending'")).rows[0].n), 47, "a dry run writes nothing");
  const first = await closeStaleReviews(db, { now: at(T0) });
  assert.deepEqual([first.signals_collapsed, first.bot_wall, first.recapture_blocked], [42, 2, 0]);
  const pending = (await db.execute("SELECT url, grp FROM status_reviews WHERE status = 'pending' ORDER BY url")).rows.map((r) => [String(r.url), String(r.grp)]);
  assert.deepEqual(pending, [["https://lamine.cc", "signals_collapsed"], ["https://sanoj.dev", "bot_wall"], ["https://www.bobmatyas.com", "bot_wall"]]);
  const closedWalls = (await db.execute("SELECT url FROM status_reviews WHERE grp = 'bot_wall' AND status = 'closed' ORDER BY url")).rows.map((r) => String(r.url));
  assert.deepEqual(closedWalls, ["https://ilkeozs.info", "https://imvinay.com"]);
  assert.equal(String((await db.execute("SELECT status FROM status_reviews WHERE batch = 'old'")).rows[0].status), "rejected", "a decided row is left as it was");
  // Twice: nothing more.
  const second = await closeStaleReviews(db, { now: at(T0 + D) });
  assert.deepEqual([second.signals_collapsed, second.bot_wall, second.recapture_blocked], [0, 0, 0]);
  // And the nightly free part runs it: no new low-signal row either.
  const night = await syncReviewRows(db, { now: at(T0 + 2 * D) });
  assert.deepEqual([night.collapsed, night.closed.signals_collapsed], [[], 0]);
});

// ---------------------------------------------------------------------------
// The address rule's brake: R1 and R2 of the #286 review

const addressRow = (url, { auto = true, status = "auto_applied", created, undone = null } = {}) => ({
  sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, signals, status, created_at, undone_at)
        VALUES (?, ?, 'door_not_portfolio', 'listed', 'remove', 0, '{}', ?, ?, ?, ?)`,
  args: [`address:${url}`, url, JSON.stringify({ door: { auto, address: true, roster: true } }), status, created, undone],
});

test("R1: a removal the owner undid never counts toward the 10-a-week brake", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  const now = at(T0 + 3 * D);
  // 10 automatic removals this week, 4 of them undone by the owner (Undo puts them back to pending).
  for (let i = 0; i < 10; i++) await db.execute(addressRow(`https://github.com/r1-${i}`, { created: at(T0 - D).toISOString(), status: i < 4 ? "pending" : "auto_applied", undone: i < 4 ? at(T0).toISOString() : null }));
  // One more tonight: 6 real + 1 = 7, under the limit.
  assert.equal(await addressBrake(db, now, { rows: 1, autos: 1 }), null);
  // Without the Undo it would have tripped: 10 + 1.
  await db.execute("UPDATE status_reviews SET undone_at = NULL, status = 'auto_applied'");
  const b = await addressBrake(db, now, { rows: 1, autos: 1 });
  assert.match(b.why, /has taken off 10 sites in the last 7 days/);
});

test("R2: a night of many held address rows and no automatic removal still raises the brake and its alert", async () => {
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  // Graded a portfolio before: each is a held row, none automatic.
  const urls = Array.from({ length: ADDRESS_AUTO_PER_NIGHT + 2 }, (_, i) => `https://github.com/held-${i}`);
  for (const u of urls) await site(db, u, { n: 5, rubric: { ...answer(true), judged_at: "2026-11-10T00:00:00Z" } });
  const s = await syncReviewRows(db, { now: at(T0) });
  assert.equal(s.address.length, urls.length);
  assert.ok(s.addressBrake, "the brake is raised");
  assert.equal(s.addressBrake.tonight, urls.length);
  for (const u of urls) assert.equal(JSON.parse(String((await reviewsOf(db, u))[0].signals)).door.brake, true, u);
  assert.deepEqual((await addressBrakeConditions(db)).map((a) => a.key), ["address-rule-brake"]);
  // At the limit, nothing raised.
  const { db: small } = await freshDb();
  await ensureReviewSchema(small);
  for (const u of urls.slice(0, ADDRESS_AUTO_PER_NIGHT)) await site(small, u, { n: 5, rubric: { ...answer(true), judged_at: "2026-11-10T00:00:00Z" } });
  assert.equal((await syncReviewRows(small, { now: at(T0) })).addressBrake, null);
  // An Undo of a held row's apply is not part of this; undoReviews is the review queue's own (tests/review-undo.test.mjs).
  assert.equal(typeof undoReviews, "function");
});

// ---------------------------------------------------------------------------
// The address rule on the address a site ends at (the 2026-11-23 benchmark: git.id.au forwards to a GitHub profile)

test("the address rule catches a listed address that forwards to a code-host profile, never one that forwards to its own GitHub Pages site", async () => {
  // The helper: the health check's final_url first, else the capture's facts.final_url.
  assert.equal(finalAddressOf({ final_url: "https://github.com/x" }), "https://github.com/x");
  assert.equal(finalAddressOf({ facts: JSON.stringify({ final_url: "https://x.dev/" }) }), "https://x.dev/");
  assert.equal(finalAddressOf({ facts: "not json" }), null);
  assert.deepEqual(addressNotPortfolio({ url: "https://git.id.au", final_url: "https://github.com/someone" }), { url: "https://github.com/someone", forwarded: true });
  assert.deepEqual(addressNotPortfolio({ url: "https://github.com/someone" }), { url: "https://github.com/someone", forwarded: false });
  for (const final of ["https://ann-lee.github.io/", "https://ann.vercel.app/", "https://ann-lee.dev/about"]) {
    assert.equal(addressNotPortfolio({ url: "https://ann-lee.dev", final_url: final }), null, final);
  }
  assert.equal(addressNotPortfolio({ url: "https://ann-lee.dev", facts: JSON.stringify({ final_url: "https://linktr.ee/ann" }) })?.forwarded, true);
  // The junk rule beside a Gemini "no" sees it too.
  assert.equal(junkCheck({ url: "https://git.id.au", name: "Someone", page_text: "", final_url: "https://github.com/someone" }).rule, "not a portfolio address");

  // At the door: Gemini's "yes" on a forwarder takes the address ladder, with words that say where it ends.
  const row = { url: "https://git.id.au", name: "Someone", page_text: "", facts: JSON.stringify({ final_url: "https://github.com/someone", signals: { score: 2 } }) };
  const d = doorDecision({ grade: { ...answer(true), facts: { signals: { score: 2 } } }, row });
  assert.equal(d.outcome, "remove");
  assert.equal(d.address, true);
  assert.match(d.why, /its address forwards to https:\/\/github\.com\/someone, which is not a portfolio page/);
  const own = doorDecision({ grade: answer(true), row: { ...row, url: "https://ann-lee.dev", facts: JSON.stringify({ final_url: "https://ann-lee.github.io/" }) } });
  assert.equal(own.outcome, "portfolio");

  // The roster pass (the night's free part), with the same ladder and brake.
  const { db } = await freshDb();
  await ensureReviewSchema(db);
  await site(db, "https://git.id.au", { n: 2 });
  await db.execute("UPDATE portfolios SET final_url = 'https://github.com/someone' WHERE url = 'https://git.id.au'");
  await site(db, "https://ann-lee.dev", { n: 5 });
  await db.execute("UPDATE portfolios SET final_url = 'https://ann-lee.github.io/' WHERE url = 'https://ann-lee.dev'");
  const s = await syncReviewRows(db, { now: at(T0) });
  assert.deepEqual(s.address, ["https://git.id.au"]);
  const [r] = await reviewsOf(db, "https://git.id.au");
  assert.deepEqual([String(r.grp), JSON.parse(String(r.signals)).door.auto], ["door_not_portfolio", true]);
  assert.match(String(r.reason), /^Its address forwards to https:\/\/github\.com\/someone/);
  assert.deepEqual(await reviewsOf(db, "https://ann-lee.dev"), []);
});
