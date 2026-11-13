// Games, badges, claims, live stats and report links without a server:
// the quiz pool and its fallback, the Daily 5, scoring and the one-answer
// rule, badge counters and idempotent awards, the guest merge, claim proofs
// and owner actions, the owner-removal plan, the live numbers and the
// one-time report links.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { buildPool, percentilesOf, pickFive, points, topPct } from "../lib/games/pool.mjs";
import { dailyId, dailyQuiz, getQuiz, progress, randomQuiz, recordGuess } from "../lib/games/quiz.mjs";
import { BADGES, checkBadges, listBadges, longestRun, recordEvent, VISIT_CAP } from "../lib/games/badges.mjs";
import { mergeGuest } from "../lib/games/merge.mjs";
import {
  MAX_VERIFIED,
  REMOVAL_HOLD_MS,
  applyDueRemovals,
  autoProof,
  pagesAccount,
  claimById,
  hostOf,
  isRemovalAlert,
  isVerifiedOwner,
  linksToGithub,
  logClaim,
  metaProof,
  metaTokens,
  openClaim,
  ownerAction,
  ownerRemovals,
  ownerState,
  pendingRemovals,
  removalConditions,
  removalProof,
  reviewQueue,
  setClaimStatus,
  logRemovalRestored,
  undoRemoval,
  undoneRemovals,
  verifiedCount,
} from "../lib/games/claims.mjs";
import { planOwnerRemovals } from "../pipeline/owner-removals.mjs";
import { githubStats, liveCounts, pacificMonthStart, siteStats, sqliteTime } from "../lib/games/stats.mjs";
import { createOneTimeLink, openLinkToken, openOneTimeLink, pruneLinks } from "../lib/grader/links.mjs";
import { printView, renderReportHtml } from "../lib/grader/report.mjs";
import { createRng } from "../lib/ranking/prng.mjs";
import { pollWeek } from "../lib/polls/week.mjs";
import { insertPoll } from "../pipeline/polls.mjs";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "games-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  await ensureRankingSchema(db);
  return db;
}

// Tuesday 2026-11-10, 12:00 Pacific.
const T0 = new Date("2026-11-10T20:00:00Z");
const site = (i) => `https://site${String(i).padStart(2, "0")}.example`;
const TIERS = ["S", "A", "A", "B", "B", "B", "C", "C", "D", "D"];

/** 20 sites on all three boards: merged rank i+1, AI reversed in pairs, People = merged. */
async function seedRatings(db, n = 20) {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    const tier = TIERS[Math.floor((i * TIERS.length) / n)];
    for (const [view, rank] of [["merged", i + 1], ["ai", i % 2 ? i : i + 2 > n ? n : i + 2], ["people", i + 1]]) {
      stmts.push({
        sql: "INSERT INTO site_ratings (view, url, rank, shown_rank, mu, sigma, confidence, tier) VALUES (?, ?, ?, ?, 25, 3, 'confident', ?)",
        args: [view, site(i), rank, rank, tier],
      });
    }
  }
  await db.batch(stmts, "write");
}

const grade = (tier, quality, extra = {}) =>
  JSON.stringify({ tier, quality_score: quality, rubric_version: 2, model: "gemini-3.5-flash-lite", is_portfolio: true, judged_at: T0.toISOString(), ...extra });

test("percentiles: top X% from a rank, points 100 minus 2.5 a point, never below 20", () => {
  assert.equal(topPct(1, 2000), 1);
  assert.equal(topPct(20, 2000), 1);
  assert.equal(topPct(21, 2000), 2);
  assert.equal(topPct(2000, 2000), 100);
  assert.equal(topPct(0, 10), null);
  assert.equal(points(30, 30), 100);
  assert.equal(points(40, 30), 75);
  assert.equal(points(46, 30), 60);
  assert.equal(points(1, 100), 20);
});

test("pool: ranks from the boards, graded sites only, owner-hidden sites left out", async () => {
  const db = await freshDb();
  await seedRatings(db);
  // An ungraded site on the board counts in the totals but is never quizzed.
  await db.execute("INSERT INTO site_ratings (view, url, rank, shown_rank, mu, sigma, confidence, tier) VALUES ('merged', 'https://ungraded.example', 21, 21, 1, 8, 'unsure', NULL)");
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, 1, ?)", args: [site(3), T0.toISOString()] });
  const pool = await buildPool(db);
  assert.equal(pool.source, "ratings");
  assert.equal(pool.totals.merged, 21);
  assert.equal(pool.sites.length, 19);
  assert.ok(!pool.sites.some((s) => s.u === site(3) || s.u === "https://ungraded.example"));
  assert.deepEqual(percentilesOf(pool, site(0)), { merged: 5, ai: 10, people: 5, tier: "S" });
  assert.equal(percentilesOf(pool, "https://nope.example"), null);
});

test("pool: before any recompute, every view falls back to the AI grade; People has none", async () => {
  const db = await freshDb();
  const rows = [
    [site(0), grade("S", 4.8)],
    [site(1), grade("A", 4.0)],
    [site(2), grade("A", 4.0)],
    [site(3), grade("C", 2.2)],
    [site(4), grade("B", 3.0, { is_portfolio: false })],
    [site(5), null],
  ];
  for (const [url, g] of rows) await db.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, g] });
  await db.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric, health) VALUES (?, 'live', ?, 'down')", args: [site(6), grade("S", 5)] });
  const pool = await buildPool(db);
  assert.equal(pool.source, "grades");
  assert.deepEqual(pool.sites.map((s) => [s.u, s.m]), [[site(0), 1], [site(1), 2], [site(2), 2], [site(3), 4]]);
  assert.deepEqual(percentilesOf(pool, site(1)), { merged: 50, ai: 50, people: null, tier: "A" });
});

test("five portfolios spread across the board, the same five for the same seed", async () => {
  const pool = { totals: { merged: 100 }, sites: Array.from({ length: 100 }, (_, i) => ({ u: site(i), m: i + 1 })) };
  const a = pickFive(pool, createRng("daily:2026-11-10"));
  assert.deepEqual(a, pickFive(pool, createRng("daily:2026-11-10")));
  assert.notDeepEqual(a, pickFive(pool, createRng("daily:2026-11-11")));
  const bands = a.map((u) => Math.floor((Number(u.match(/site(\d+)/)[1]) / 100) * 5)).sort();
  assert.deepEqual(bands, [0, 1, 2, 3, 4]);
  assert.equal(new Set(pickFive({ sites: pool.sites.slice(0, 3) }, Math.random)).size, 3);
});

test("the Daily 5 is the same for everyone that Pacific day and stays put when the board changes", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const pool = await buildPool(db);
  const q = await dailyQuiz(db, pool, { now: T0 });
  assert.equal(q.id, "daily-2026-11-10");
  assert.equal(q.urls.length, 5);
  // 23:30 Pacific is still the 10th; the stored quiz answers even for another pool.
  const later = await dailyQuiz(db, { totals: pool.totals, sites: pool.sites.slice(10) }, { now: new Date("2026-11-11T07:30:00Z") });
  assert.deepEqual(later.urls, q.urls);
  // The same date on a fresh database draws the same five.
  const db2 = await freshDb();
  await seedRatings(db2);
  assert.deepEqual((await dailyQuiz(db2, await buildPool(db2), { now: T0 })).urls, q.urls);
  const next = await dailyQuiz(db, pool, { now: new Date("2026-11-11T08:00:00Z") });
  assert.equal(next.id, dailyId("2026-11-11"));
  assert.equal(await dailyQuiz(await freshDb(), { sites: [] }, { now: T0 }), null);
});

test("guesses: scored on the server, one answer a round, the fifth finishes the play", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const pool = await buildPool(db);
  const quiz = await randomQuiz(db, pool, { id: "r-abcdefghij", now: T0, rng: createRng("x") });
  assert.deepEqual((await getQuiz(db, "r-abcdefghij")).urls, quiz.urls);
  const actual = quiz.urls.map((u) => percentilesOf(pool, u).merged);

  const first = await recordGuess(db, { quiz, player: "anon:p", index: 0, guess: actual[0], pool, now: T0 });
  assert.equal(first.ok, true);
  assert.equal(first.result.points, 100);
  assert.equal(first.result.hit, true);
  assert.equal(first.finished, null);
  const again = await recordGuess(db, { quiz, player: "anon:p", index: 0, guess: 1, pool, now: T0 });
  assert.equal(again.error, "already_guessed");
  assert.equal(again.result.guess, actual[0]);
  assert.equal((await recordGuess(db, { quiz, player: "anon:p", index: 5, guess: 1, pool, now: T0 })).error, "bad_index");

  // 16 points off: not a hit, 60 points.
  const off = Math.min(100, actual[1] + 16) === actual[1] + 16 ? actual[1] + 16 : actual[1] - 16;
  const miss = await recordGuess(db, { quiz, player: "anon:p", index: 1, guess: off, pool, now: T0 });
  assert.equal(miss.result.hit, false);
  assert.equal(miss.result.points, 60);
  for (const i of [2, 3]) await recordGuess(db, { quiz, player: "anon:p", index: i, guess: actual[i], pool, now: T0 });
  const last = await recordGuess(db, { quiz, player: "anon:p", index: 4, guess: actual[4], pool, now: T0 });
  assert.deepEqual(last.finished, { score: 460, hits: 4, perfect: false });
  const mine = await progress(db, quiz.id, "anon:p");
  assert.equal(mine.finished, true);
  assert.equal(mine.results.length, 5);
  assert.equal(Number((await db.execute("SELECT n FROM game_totals WHERE k = 'quizzes'")).rows[0].n), 1);
  // Another player replays the same five (a challenge link).
  for (let i = 0; i < 5; i++) await recordGuess(db, { quiz, player: "gh:9", index: i, guess: actual[i], pool, now: T0 });
  assert.equal((await progress(db, quiz.id, "gh:9")).hits, 5);
  assert.equal(Number((await db.execute("SELECT n FROM game_totals WHERE k = 'quizzes'")).rows[0].n), 2);
});

test("a round whose site left the pool scores nothing and is not a hit", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const pool = await buildPool(db);
  const quiz = await randomQuiz(db, pool, { id: "r-0123456789", now: T0, rng: createRng("y") });
  const smaller = { ...pool, sites: pool.sites.filter((s) => s.u !== quiz.urls[0]) };
  const r = await recordGuess(db, { quiz, player: "anon:q", index: 0, guess: 50, pool: smaller, now: T0 });
  assert.deepEqual([r.result.merged, r.result.points, r.result.hit], [null, 0, false]);
});

test("longest run of consecutive days", () => {
  assert.equal(longestRun([]), 0);
  assert.equal(longestRun(["2026-11-01", "2026-11-02", "2026-11-04"]), 2);
  assert.equal(longestRun(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-02"]), 3);
});

const sqlTime = (d) => new Date(d).toISOString().slice(0, 19).replace("T", " ");

test("badges: counters from votes, quizzes, polls and lists; awarded once; told once", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const pool = await buildPool(db);
  const me = "gh:42";
  // 10 votes on 7 straight Pacific days (Nov 3 to 9), the first at 01:00 Pacific; all agree with People.
  const votes = [];
  for (let i = 0; i < 10; i++) {
    const at = new Date(Date.UTC(2026, 10, 3 + Math.min(i, 6), i === 0 ? 9 : 20, i)); // 01:00 Pacific on Nov 3, then midday
    votes.push({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES (?, ?, ?, 'human', ?, ?)", args: [site(i), site(i + 10), `k${i}`, me, sqlTime(at)] });
  }
  await db.batch(votes, "write");
  // A perfect Daily 5 three days running.
  for (const day of ["2026-11-08", "2026-11-09", "2026-11-10"]) {
    await db.execute({ sql: "INSERT INTO quiz_plays (quiz_id, player, started_at, finished_at, score, hits) VALUES (?, ?, ?, ?, 500, 5)", args: [dailyId(day), me, `${day}T20:00:00.000Z`, `${day}T20:05:00.000Z`] });
  }
  // Poll votes in four weeks running.
  let w = pollWeek(T0);
  for (let i = 0; i < 4; i++) {
    await insertPoll(db, { week: w, kind: "text", question: `Q${i}?`, options: [{ label: "A" }, { label: "B" }], source: "code", now: w.opensAt.getTime() });
    await db.execute({ sql: "INSERT INTO poll_votes (poll_id, voter, browser, option_idx, created_at) VALUES (?, ?, ?, 0, ?)", args: [w.id, me, `anon:b${i}`, w.opensAt.toISOString()] });
    w = pollWeek(new Date(w.opensAt.getTime() - 3600000));
  }
  // A list with 10 sites.
  const list = await db.execute({ sql: "INSERT INTO lists (owner, name, slug) VALUES (?, 'Faves', 'faves-1') RETURNING id", args: [me] });
  const id = Number(list.rows[0].id);
  for (let i = 0; i < 10; i++) await db.execute({ sql: "INSERT INTO list_items (list_id, url) VALUES (?, ?)", args: [id, site(i + 5)] });
  await recordEvent(db, me, "share");
  await recordEvent(db, me, "grade");

  const first = await checkBadges(db, me, { pool, now: T0, signedIn: true, earlyUntil: "2026-12-31" });
  const c = first.counters;
  assert.equal(c.votes, 10);
  assert.equal(c.lateVotes, 1);
  assert.equal(c.dayStreak, 8, "votes Nov 3 to 9, then the Daily 5 on the 10th");
  assert.equal(c.dailyStreak, 3);
  assert.equal(c.perfectQuizzes, 3);
  assert.equal(c.crowdAgreed, 10);
  assert.equal(c.polls, 4);
  assert.equal(c.pollStreak, 4);
  assert.equal(c.lists, 1);
  assert.equal(c.biggestList, 10);
  assert.equal(c.shares, 1);
  assert.equal(c.grades, 1);
  assert.equal(c.early, 1);
  assert.deepEqual(first.eye.votes.crowd, { agree: 10, of: 10, pct: 100 });
  for (const b of ["vote", "votes10", "quiz", "perfect", "daily3", "streak7", "grade", "list", "list10", "share", "crowd10", "poll", "pollstreak", "owl", "early"]) {
    assert.ok(first.awarded.includes(b), `awarded ${b}`);
  }
  assert.ok(!first.awarded.includes("votes100") && !first.awarded.includes("visit50") && !first.awarded.includes("gem"));

  // A second check awards nothing new (forced, so it really re-reads).
  assert.deepEqual((await checkBadges(db, me, { pool, now: T0, force: true, signedIn: true, earlyUntil: "2026-12-31" })).awarded, []);
  // An earned badge stays earned when its counter drops.
  await db.execute({ sql: "DELETE FROM votes WHERE rater_id = ?", args: [me] });
  const listed = await listBadges(db, me, { pool, now: T0, force: true, signedIn: true });
  const vote = listed.badges.find((b) => b.id === "vote");
  assert.equal(vote.earned, true);
  assert.equal(vote.new, true);
  assert.equal(vote.progress, 0);
  const locked = listed.badges.find((b) => b.id === "votes1000");
  assert.deepEqual([locked.earned, locked.target], [false, 1000]);
  assert.equal(listed.badges.length, BADGES.length);
  assert.equal((await listBadges(db, me, { pool, now: T0, signedIn: true })).badges.find((b) => b.id === "vote").new, false, "told once");
});

test("badges: a check is reused for a few seconds; past the early window nobody new is early", async () => {
  const db = await freshDb();
  const pool = { totals: { merged: 0, ai: 0, people: 0 }, sites: [] };
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES ('a', 'b', 'k', 'anon', 'anon:x', ?)", args: [sqlTime(T0)] });
  const a = await checkBadges(db, "anon:x", { pool, now: T0, signedIn: false, earlyUntil: "2026-11-01" });
  assert.equal(a.counters.early, 0);
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES ('a', 'c', 'k2', 'anon', 'anon:x', ?)", args: [sqlTime(T0)] });
  assert.equal((await checkBadges(db, "anon:x", { pool, now: new Date(T0.getTime() + 5000), signedIn: false })).counters.votes, 1, "reused");
  assert.equal((await checkBadges(db, "anon:x", { pool, now: new Date(T0.getTime() + 20000), signedIn: false })).counters.votes, 2);
});

test("badges: Hidden gem counts a saved site that later reached the top 10%", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const me = "gh:7";
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)", args: [me, site(15)] });
  const pool = await buildPool(db);
  assert.equal((await checkBadges(db, me, { pool, now: T0, signedIn: true })).counters.gems, 0);
  // site15 climbs to the top.
  const climbed = { ...pool, sites: pool.sites.map((s) => (s.u === site(15) ? { ...s, m: 1 } : s)) };
  const out = await checkBadges(db, me, { pool: climbed, now: T0, force: true, signedIn: true });
  assert.equal(out.counters.gems, 1);
  assert.ok(out.awarded.includes("gem"));
});

test("badge events: visits are distinct and stop at the Explorer target; unknown kinds throw", async () => {
  const db = await freshDb();
  assert.equal(await recordEvent(db, "anon:v", "visit", { url: site(1) }), true);
  assert.equal(await recordEvent(db, "anon:v", "visit", { url: site(1) }), false);
  for (let i = 2; i < VISIT_CAP + 5; i++) await recordEvent(db, "anon:v", "visit", { url: `https://v${i}.example` });
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM player_visits WHERE player = 'anon:v'")).rows[0].n), VISIT_CAP);
  await assert.rejects(recordEvent(db, "anon:v", "vote"));
});

test("badge events: a grade level keeps the best one and earns every badge up to it", async () => {
  const db = await freshDb();
  const pool = { totals: { merged: 0, ai: 0, people: 0 }, sites: [] };
  assert.equal(await recordEvent(db, "anon:l", "level", { level: 0 }), false);
  assert.equal(await recordEvent(db, "anon:l", "level", { level: 9 }), false);
  assert.equal(await recordEvent(db, "anon:l", "level", { level: 3 }), true);
  assert.equal(await recordEvent(db, "anon:l", "level", { level: 2 }), false, "a lower level never replaces a higher one");
  const out = await checkBadges(db, "anon:l", { pool, now: T0, force: true, signedIn: false });
  assert.equal(out.counters.gradeLevel, 3);
  assert.deepEqual(out.awarded.filter((id) => ["top25", "top10", "top5", "stier"].includes(id)).sort(), ["top10", "top25"]);
  assert.equal(await recordEvent(db, "anon:l", "level", { level: 5 }), true);
  const s = await checkBadges(db, "anon:l", { pool, now: T0, force: true, signedIn: false });
  assert.deepEqual(s.awarded.sort(), ["stier", "top5"]);
});

test("a guest's quizzes, badges and counters move to the account at sign-in; the account's own play wins", async () => {
  const db = await freshDb();
  await seedRatings(db);
  const pool = await buildPool(db);
  const q1 = await randomQuiz(db, pool, { id: "r-aaaaaaaaaa", now: T0, rng: createRng(1) });
  const q2 = await randomQuiz(db, pool, { id: "r-bbbbbbbbbb", now: T0, rng: createRng(2) });
  await recordGuess(db, { quiz: q1, player: "anon:g", index: 0, guess: 10, pool, now: T0 });
  await recordGuess(db, { quiz: q2, player: "anon:g", index: 0, guess: 10, pool, now: T0 });
  await recordGuess(db, { quiz: q2, player: "gh:1", index: 0, guess: 90, pool, now: T0 });
  await recordEvent(db, "anon:g", "share");
  await recordEvent(db, "gh:1", "share");
  await recordEvent(db, "anon:g", "visit", { url: site(1) });
  await db.execute({ sql: "INSERT INTO badges (player, badge, earned_at) VALUES ('anon:g', 'share', '2026-11-01T00:00:00.000Z'), ('gh:1', 'share', '2026-11-05T00:00:00.000Z')" });
  await mergeGuest(db, { guest: "anon:g", account: "gh:1" });
  await mergeGuest(db, { guest: "anon:g", account: "gh:1" }); // idempotent
  assert.equal((await progress(db, q1.id, "gh:1")).results[0].guess, 10);
  assert.equal((await progress(db, q2.id, "gh:1")).results[0].guess, 90, "the account's own answer stands");
  assert.equal(Number((await db.execute("SELECT n FROM player_counters WHERE player = 'gh:1' AND k = 'shares'")).rows[0].n), 2);
  assert.equal(String((await db.execute("SELECT earned_at FROM badges WHERE player = 'gh:1' AND badge = 'share'")).rows[0].earned_at), "2026-11-01T00:00:00.000Z");
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM player_visits WHERE player = 'gh:1'")).rows[0].n), 1);
  for (const t of ["quiz_plays", "quiz_guesses", "player_counters", "player_visits", "badges"]) {
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t} WHERE player = 'anon:g'`)).rows[0].n), 0, t);
  }
  assert.deepEqual(await mergeGuest(db, { guest: "gh:2", account: "gh:1" }), { moved: false }, "only a guest id merges");
});

test("claims: the GitHub link and the meta tag", () => {
  const html = `<a href="https://github.com/Octo-Cat">GitHub</a><meta content="tok123" name="portfoliorank-verify">`;
  assert.equal(linksToGithub(html, "octo-cat"), true);
  for (const href of ["https://github.com/octo-cat/", "https://www.github.com/octo-cat?tab=repositories", "//github.com/octo-cat#top"]) {
    assert.equal(linksToGithub(`<a href="${href}">`, "octo-cat"), true, href);
  }
  assert.equal(linksToGithub(`<a href=https://github.com/octo-cat>`, "octo-cat"), true, "unquoted");
  // A collaborator's or a library's repository says nothing about who owns the site.
  for (const html of [`<a href="https://github.com/octo-cat/repo">`, `<a href="https://github.com/octo-cat/repo/">`, `<a href=https://github.com/octo-cat/shared-app>`, `<a href="https://github.com/octo-cat/lib">x</a><a href="https://github.com/bob">`]) {
    assert.equal(linksToGithub(html, "octo-cat"), false, html);
  }
  assert.equal(linksToGithub(`<a href="https://github.com/octo-catalog">`, "octo-cat"), false);
  assert.equal(linksToGithub(`<p>github.com/octo-cat</p>`, "octo-cat"), false, "a link, not text");
  assert.equal(linksToGithub(html, "bad login!"), false);
  assert.deepEqual(metaTokens(html + `<meta name="portfoliorank-verify" content='two'>`), ["tok123", "two"]);
  assert.equal(hostOf("www.Jane.dev/"), "jane.dev");

  const url = "https://jane.dev";
  const page = { html, finalUrl: "https://www.jane.dev/" };
  assert.equal(autoProof({ url, page, login: "octo-cat" }), "github_link");
  // A template clone's footer links the template's author: not proof.
  assert.equal(autoProof({ url, page, login: "octo-cat", template: "Brittany Chiang v4 clone" }), null);
  // A page that redirected elsewhere proves nothing.
  assert.equal(autoProof({ url, page: { html, finalUrl: "https://github.com/octo-cat" }, login: "octo-cat" }), null);
  // The GitHub profile's Website field is free text anyone can set to any
  // domain: it never proves who controls the site.
  const profile = { id: 1, login: "mallory", blog: "jane.dev" };
  assert.equal(autoProof({ url, page: null, profile, ownerId: "gh:1", login: "mallory" }), null);
  assert.equal(autoProof({ url, page: { html: "<p>Jane</p>", finalUrl: url }, profile, ownerId: "gh:1", login: "mallory" }), null);
  assert.equal(metaProof({ url, page, token: "tok123" }), true);
  assert.equal(metaProof({ url, page, token: "nope" }), false);
});

test("claims: owner actions need a verified claim, and every step is in the audit log", async () => {
  const db = await freshDb();
  const url = site(1);
  const claim = await openClaim(db, { url, owner: "gh:1", login: "jane", token: "tok", now: T0 });
  assert.equal(claim.status, "pending");
  assert.equal((await openClaim(db, { url, owner: "gh:1", login: "jane", token: "other", now: T0 })).token, "tok", "one claim per account and site");
  assert.deepEqual(await ownerAction(db, { url, owner: "gh:1", action: "remove", now: T0 }), { ok: false, error: "not_owner" });
  await setClaimStatus(db, { claim, status: "review", method: "manual", note: "It's mine", actor: "gh:1", now: T0 });
  assert.equal((await reviewQueue(db)).length, 1);
  await setClaimStatus(db, { claim: await claimById(db, claim.id), status: "verified", actor: "admin:n8", now: T0 });
  assert.equal(await isVerifiedOwner(db, { url, owner: "gh:1" }), true);
  assert.equal(await isVerifiedOwner(db, { url, owner: "gh:2" }), false);

  assert.deepEqual((await ownerAction(db, { url, owner: "gh:1", action: "hide_grade", now: T0 })).state, { hideGrade: true, removedAt: null, removeAfter: null });
  assert.deepEqual((await ownerAction(db, { url, owner: "gh:1", action: "regrade", now: T0 })).regrade, { queued: true, pending: true });
  assert.deepEqual((await ownerAction(db, { url, owner: "gh:1", action: "regrade", now: T0 })).regrade, { queued: false, pending: true });
  // Reviewed by the site owner, so it may remove; the removal waits a day.
  assert.equal(await removalProof(db, { url, owner: "gh:1" }), true);
  const held = await ownerAction(db, { url, owner: "gh:1", action: "remove", now: T0 });
  const after = new Date(T0.getTime() + REMOVAL_HOLD_MS).toISOString();
  assert.deepEqual(held.state, { hideGrade: true, removedAt: null, removeAfter: after }, "removing keeps the hidden grade");
  assert.equal((await ownerAction(db, { url, owner: "gh:1", action: "remove", now: new Date(T0.getTime() + 1000) })).state.removeAfter, after, "asking again doesn't move the date");
  assert.deepEqual(await ownerRemovals(db), [], "not removed while held");
  assert.deepEqual((await pendingRemovals(db)).map((p) => [p.url, p.removeAfter, p.requestedBy, p.login]), [[url, after, "gh:1", "jane"]]);
  const [alert] = await removalConditions(db);
  assert.equal(alert.key, `removal:${url}`);
  assert.ok(isRemovalAlert(alert.key));
  assert.match(alert.detail, /@jane asked to remove/);
  assert.match(alert.detail, /\/api\/admin\/removals/);
  // An hour early: still held. On time: removed.
  assert.deepEqual(await applyDueRemovals(db, { now: new Date(T0.getTime() + REMOVAL_HOLD_MS - 3600000) }), []);
  assert.deepEqual(await applyDueRemovals(db, { now: new Date(T0.getTime() + REMOVAL_HOLD_MS) }), [url]);
  assert.deepEqual(await applyDueRemovals(db, { now: new Date(T0.getTime() + REMOVAL_HOLD_MS + 1000) }), [], "once");
  assert.deepEqual(await ownerRemovals(db), [{ url, removedAt: after }]);
  assert.deepEqual(await removalConditions(db), []);
  assert.equal((await ownerAction(db, { url, owner: "gh:1", action: "cancel_remove", now: T0 })).state.removedAt, after, "too late to cancel");
  assert.equal((await ownerAction(db, { url, owner: "gh:1", action: "nuke", now: T0 })).error, "bad_action");
  assert.deepEqual(await ownerState(db, site(2)), { hideGrade: false, removedAt: null, removeAfter: null });
  const log = (await db.execute({ sql: "SELECT action FROM claim_log WHERE url = ? ORDER BY id", args: [url] })).rows.map((r) => String(r.action));
  assert.deepEqual(log, ["claim_started", "claim_review", "claim_verified", "hide_grade", "regrade_requested", "regrade_already_pending", "remove_requested", "remove"]);
  assert.equal(MAX_VERIFIED, 3);

  // The admin undoes it: listed again, and the audit log says who.
  const undone = await undoRemoval(db, { url, actor: "admin:n8", now: T0 });
  assert.deepEqual([undone.ok, undone.wasRemoved, undone.state.removedAt], [true, true, null]);
  assert.deepEqual(await ownerRemovals(db), []);
  assert.equal((await undoRemoval(db, { url, actor: "admin:n8", now: T0 })).error, "not_removed");
});

test("claims: a github.io site is its own account's, and a link on someone else's github.io proves nothing", async () => {
  const html = `<a href="https://github.com/octo-cat">GitHub</a> <a href="https://github.com/mallory">Designed by Mallory</a>`;
  const url = "https://octo-cat.github.io/";
  assert.equal(pagesAccount(url), "octo-cat");
  assert.equal(pagesAccount("https://octo-cat.dev"), null);
  assert.equal(autoProof({ url, page: { html, finalUrl: url }, login: "Octo-Cat" }), "github_pages");
  // The page links Mallory too (a credit, a collaborator): not Mallory's site.
  assert.equal(autoProof({ url, page: { html, finalUrl: url }, login: "mallory" }), null);
  // A fork lives at the forker's own address: Mallory's copy proves nothing about Octo-cat's listing.
  assert.equal(autoProof({ url, page: { html, finalUrl: "https://mallory.github.io/" }, login: "mallory" }), null);
  assert.equal(autoProof({ url: "https://octo-cat.github.io/portfolio/", page: null, login: "octo-cat" }), "github_pages");
});

test("claims: a link proves enough to ask for a re-grade, not to hide a grade or remove the site; the meta tag does", async () => {
  const db = await freshDb();
  const url = site(4);
  const claim = await openClaim(db, { url, owner: "gh:7", login: "bob", token: "tok", now: T0 });
  await setClaimStatus(db, { claim, status: "verified", method: "github_link", actor: "gh:7", now: T0 });
  assert.equal(await removalProof(db, { url, owner: "gh:7" }), false);
  assert.deepEqual(await ownerAction(db, { url, owner: "gh:7", action: "remove", now: T0 }), { ok: false, error: "remove_needs_meta" });
  // A collaborator linked from the page can't hide someone's grade.
  assert.deepEqual(await ownerAction(db, { url, owner: "gh:7", action: "hide_grade", now: T0 }), { ok: false, error: "hide_needs_meta" });
  assert.equal((await ownerAction(db, { url, owner: "gh:7", action: "regrade", now: T0 })).ok, true, "a re-grade request is fine");
  assert.deepEqual(await ownerState(db, url), { hideGrade: false, removedAt: null, removeAfter: null });
  // A verification logged by someone who isn't the admin is no review.
  await logClaim(db, { url, actor: "gh:7", action: "claim_verified", detail: { claim: claim.id }, now: T0 });
  assert.equal(await removalProof(db, { url, owner: "gh:7" }), false);

  // With the meta tag it may; and while held, the owner can cancel.
  await setClaimStatus(db, { claim: await claimById(db, claim.id), status: "verified", method: "meta", actor: "gh:7", now: T0 });
  assert.equal(await removalProof(db, { url, owner: "gh:7" }), true);
  assert.equal((await ownerAction(db, { url, owner: "gh:7", action: "hide_grade", now: T0 })).ok, true);
  assert.ok((await ownerAction(db, { url, owner: "gh:7", action: "remove", now: T0 })).state.removeAfter);
  assert.deepEqual((await ownerAction(db, { url, owner: "gh:7", action: "cancel_remove", now: T0 })).state, { hideGrade: true, removedAt: null, removeAfter: null });
  assert.deepEqual(await applyDueRemovals(db, { now: new Date(T0.getTime() + 2 * REMOVAL_HOLD_MS) }), [], "a cancelled removal never happens");
  // A held removal the admin undoes never happens either.
  await ownerAction(db, { url, owner: "gh:7", action: "remove", now: T0 });
  assert.equal((await undoRemoval(db, { url, actor: "admin:n8", now: T0 })).wasRemoved, false);
  assert.deepEqual(await applyDueRemovals(db, { now: new Date(T0.getTime() + 2 * REMOVAL_HOLD_MS) }), []);
  const log = (await db.execute({ sql: "SELECT action FROM claim_log WHERE url = ? ORDER BY id", args: [url] })).rows.map((r) => String(r.action));
  assert.deepEqual(log.slice(-4), ["remove_requested", "remove_cancelled", "remove_requested", "removal_undone"]);
});

test("claims: a claim verified by the retired profile-Website proof gives no owner rights", async () => {
  const db = await freshDb();
  const url = site(3);
  // Verified before the proof was retired: Mallory set her GitHub Website to someone else's domain.
  const claim = await openClaim(db, { url, owner: "gh:66", login: "mallory", token: "tok", now: T0 });
  await setClaimStatus(db, { claim, status: "verified", method: "github_blog", actor: "gh:66", now: T0 });
  assert.equal(await isVerifiedOwner(db, { url, owner: "gh:66" }), false);
  assert.equal(await verifiedCount(db, "gh:66"), 0);
  assert.deepEqual(await ownerAction(db, { url, owner: "gh:66", action: "remove", now: T0 }), { ok: false, error: "not_owner" });
  assert.deepEqual(await ownerAction(db, { url, owner: "gh:66", action: "hide_grade", now: T0 }), { ok: false, error: "not_owner" });
  assert.deepEqual(await ownerState(db, url), { hideGrade: false, removedAt: null, removeAfter: null });
  // The claim reads as pending, so its owner can prove it again with a link or the meta tag.
  assert.equal((await claimById(db, claim.id)).status, "pending");
  assert.equal((await openClaim(db, { url, owner: "gh:66", login: "mallory", token: "x", now: T0 })).status, "pending");
  await setClaimStatus(db, { claim: await claimById(db, claim.id), status: "verified", method: "meta", actor: "gh:66", now: T0 });
  assert.equal(await isVerifiedOwner(db, { url, owner: "gh:66" }), true, "a real proof verifies it again");
});

test("owner removals join data/excluded.json as owner requests, without names, and leave the feed", () => {
  const feed = [{ url: "https://a.dev", name: "A" }, { url: "https://b.dev/", name: "B" }];
  const excluded = [{ url: "https://old.dev", kind: "down" }];
  const plan = planOwnerRemovals({ removals: [{ url: "https://www.b.dev", removedAt: T0.toISOString() }, { url: "https://old.dev", removedAt: T0.toISOString() }], excluded, feed });
  assert.deepEqual(plan.added, [{ url: "https://b.dev/", reason: "owner request", kind: "owner_request", removed: "2026-11-10" }]);
  assert.deepEqual(plan.feed.map((p) => p.url), ["https://a.dev"]);
  assert.equal(plan.excluded.length, 2);
  assert.equal(planOwnerRemovals({ removals: [], excluded, feed }).added.length, 0);
});

test("an undone removal comes back out of data/excluded.json, owner requests only, and the restore is logged once", async () => {
  const db = await freshDb();
  const feed = [{ url: "https://a.dev", name: "A" }];
  const excluded = [
    { url: "https://b.dev/", reason: "owner request", kind: "owner_request", removed: "2026-11-10" },
    { url: "https://c.dev", reason: "owner request", kind: "owner_request", removed: "2026-11-10" },
    { url: "https://down.dev", kind: "down" },
    "https://legacy.dev",
  ];
  const at = new Date("2026-11-10T20:00:00Z");
  for (const u of ["https://b.dev/", "https://c.dev", "https://down.dev"]) {
    await db.execute({ sql: "INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES (?, ?, ?)", args: [u, at.toISOString(), at.toISOString()] });
  }
  // The admin undoes b and down.dev; c stays removed.
  for (const u of ["https://b.dev/", "https://down.dev"]) await undoRemoval(db, { url: u, actor: "admin:me", now: new Date("2026-11-11T10:00:00Z") });
  const removals = await ownerRemovals(db);
  const undone = await undoneRemovals(db);
  assert.deepEqual(undone.map((u) => u.url), ["https://b.dev/", "https://down.dev"]);
  const plan = planOwnerRemovals({ removals, undone, excluded, feed });
  assert.deepEqual(plan.restored, ["https://b.dev/"]);
  assert.deepEqual(plan.excluded.map((e) => (typeof e === "string" ? e : e.url)), ["https://c.dev", "https://down.dev", "https://legacy.dev"]);
  // Run again on the result: nothing more to do.
  assert.deepEqual(planOwnerRemovals({ removals, undone, excluded: plan.excluded, feed }).restored, []);

  // Audit: one removal_restored row per undo, however often the job runs.
  assert.deepEqual(await logRemovalRestored(db, plan.restored, { now: new Date("2026-11-15T17:00:00Z") }), ["https://b.dev/"]);
  assert.deepEqual(await logRemovalRestored(db, plan.restored, { now: new Date("2026-11-16T17:00:00Z") }), []);
  const log = (await db.execute("SELECT action, actor FROM claim_log WHERE url = 'https://b.dev/' ORDER BY id")).rows.map((r) => `${r.actor}:${r.action}`);
  assert.deepEqual(log, ["admin:me:removal_undone", "system:removal_restored"]);

  // Removed again later: not undone any more, so it is excluded again and not restored.
  await db.execute({ sql: "UPDATE portfolio_owner SET removed_at = ? WHERE url = 'https://b.dev/'", args: ["2026-11-20T00:00:00Z"] });
  assert.deepEqual((await undoneRemovals(db)).map((u) => u.url), ["https://down.dev"]);
});

test("live stats: one pass over the list, today's votes by Pacific day, GitHub numbers", async () => {
  const db = await freshDb();
  const facts = (own, resume) => ({ facts: { own_domain: own, resume } });
  const recent = new Date(T0.getTime() - 86400000).toISOString();
  const old = new Date(T0.getTime() - 30 * 86400000).toISOString();
  await db.batch(
    [
      ["https://a.dev", grade("S", 5, { ...facts(true, true), judged_at: recent })],
      ["https://b.dev", grade("B", 3, { ...facts(false, true), judged_at: old })],
      ["https://c.dev", grade("C", 2, { ...facts(true, false), judged_at: old })],
      ["https://d.dev", null],
    ].map(([url, g]) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, g] })),
    "write"
  );
  await db.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric, delisted_at) VALUES ('https://gone.dev', 'live', ?, ?)", args: [grade("S", 5), old] });
  await db.execute({ sql: "INSERT INTO rating_resets (url, at, reason) VALUES ('https://a.dev', ?, 'page_changed'), ('https://a.dev', ?, 'page_changed'), ('https://b.dev', ?, 'page_changed')", args: [recent, recent, old] });
  const feed = [
    { url: "https://a.dev", name: "A", tagline: "Full Stack Developer" },
    { url: "https://b.dev", name: "B", tagline: "Frontend engineer" },
    { url: "https://c.dev", name: "C", tagline: "Full-stack dev" },
    { url: "https://d.dev", name: "D" },
  ];
  const s = await siteStats(db, { feed, now: T0 });
  assert.equal(s.portfolios, 4);
  assert.equal(s.graded, 3);
  assert.equal(s.gradedThisWeek, 1);
  assert.equal(s.ownDomainPct, 67);
  assert.equal(s.resumePct, 67);
  assert.deepEqual(s.commonRole, { key: "fullstack", label: "Full stack", pct: 67 });
  assert.deepEqual(s.averageTier, { value: 3.33, tier: "B" });
  assert.equal(s.changedThisMonth, 1);
  assert.deepEqual(s.newest, { url: "https://d.dev", name: "D" });
  assert.equal(pacificMonthStart(T0).toISOString(), "2026-11-01T07:00:00.000Z");

  // Midnight Pacific on the 10th is 08:00 UTC.
  for (const at of ["2026-11-10T07:59:00Z", "2026-11-10T08:00:00Z", "2026-11-10T19:00:00Z"]) {
    await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES ('x', 'y', ?, 'human', 'gh:1', ?)", args: [at, sqliteTime(at)] });
  }
  await db.execute("INSERT INTO game_totals (k, n) VALUES ('quizzes', 4)");
  assert.deepEqual(await liveCounts(db, { now: T0 }), { votesToday: 2, votes: 3, quizzesPlayed: 4 });

  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(String(u));
    if (String(u).includes("/contributors")) return new Response("[{}]", { headers: { link: '<https://api.github.com/x?per_page=1&anon=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&anon=1&page=1234>; rel="last"' } });
    return Response.json({ stargazers_count: 56 });
  };
  assert.deepEqual(await githubStats({ repo: "n8watkins/portfolio-rank", fetchImpl }), { stars: 56, contributors: 1234 });
  assert.equal(calls[0], "https://api.github.com/repos/n8watkins/portfolio-rank");
  assert.deepEqual(await githubStats({ repo: "x/y", fetchImpl: async () => new Response("", { status: 403 }) }), { stars: null, contributors: null });
});

test("report links: the shared one-time links, scope report-link: a nonce hash, open once, a day, never a grade link", async () => {
  const db = await freshDb();
  const secret = "test-secret";
  const now = T0.getTime();
  const { token } = await createOneTimeLink(db, { scope: "report-link", subject: site(1), secret, now });
  const row = (await db.execute("SELECT job_id, scope FROM grade_links")).rows[0];
  assert.deepEqual([row.job_id, row.scope], [site(1), "report-link"]);
  // A report link is not a grade link, and the other way round.
  assert.equal((await openLinkToken(db, token, { secret, now })).error, "bad");
  assert.deepEqual(await openOneTimeLink(db, token, { scope: "report-link", secret, now }), { ok: true, subject: site(1) });
  assert.deepEqual(await openOneTimeLink(db, token, { scope: "report-link", secret, now }), { ok: false, error: "used", subject: site(1) });
  const late = await createOneTimeLink(db, { scope: "report-link", subject: site(1), secret, now });
  assert.equal((await openOneTimeLink(db, late.token, { scope: "report-link", secret, now: now + 25 * 3600000 })).error, "expired");
  assert.equal((await openOneTimeLink(db, "short", { scope: "report-link", secret, now })).error, "bad");
  await assert.rejects(createOneTimeLink(db, { scope: "report-link", subject: "javascript:alert(1)", secret, now }));
  assert.equal(await pruneLinks(db, { now: now + 2 * 86400000 }), 2);
});

test("the print report escapes what it shows and keeps the tier letter for the top tiers", () => {
  assert.equal(printView("{nope"), null);
  assert.equal(printView(JSON.stringify({ tier: "Z" })), null);
  const g = printView(JSON.stringify({ tier: "D", quality_score: 1.5, visual_design: { score: 2, note: "<b>busy</b>" }, writing: 3, checks: { resume: true, github: false } }));
  assert.equal(g.showTier, false);
  assert.deepEqual(g.judgments.map((j) => [j.id, j.score]), [["visual_design", 2], ["writing", 3]], "older bare scores count too");
  const html = renderReportHtml({ name: "Zoë <script>", url: "https://z.dev", tagline: null, view: g, percentiles: { merged: 40, ai: 38, people: null }, hero: null, siteUrl: "https://portfoliorank.dev", now: T0 });
  assert.ok(html.includes("Zoë &lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;b&gt;busy&lt;/b&gt;"));
  assert.ok(html.includes("Top 40%"));
  assert.ok(!html.includes(">D<"), "no public D");
  assert.ok(html.includes("@media print"));
  assert.ok(html.includes("✓ Resume link") && html.includes("✗ GitHub link"));
  // The CSP allows no inline event handlers: the print button's script is a file.
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.ok(html.includes('<script src="/report-print.js" defer></script>'));
});
