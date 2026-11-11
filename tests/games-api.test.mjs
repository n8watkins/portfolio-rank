// End to end: the games, badges, claims, live stats and report APIs on the
// running production build with GAMES_V2=true (`npm run test:e2e`): a
// Daily 5 that never leaks a percentile before the guess, scoring and the
// one-answer rule, challenge links, badges and the guest merge at sign-in,
// claims through review to owner actions, the live numbers, the report
// download and its one-time link, and the abuse cases (forged origins, bad
// input, rate limits, strangers acting as owners).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { createReportLink } from "../lib/games/report.mjs";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const GH_PORT = Number(process.env.E2E_GAMES_GH_PORT ?? 7694);
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Twenty listed sites on all three boards; the report site has a grade.
const SITES = feed.slice(100, 120).map((p) => p.url);
const REPORT = SITES[0];
const OWNED = feed[150].url;

// A stand-in for the GitHub API (GAMES_TEST_GITHUB_API in scripts/test-e2e.sh).
const gh = createServer((req, res) => {
  if (req.url.includes("/contributors")) {
    res.writeHead(200, { "content-type": "application/json", link: '<http://x/?per_page=1&page=2>; rel="next", <http://x/?per_page=1&page=321>; rel="last"' });
    return res.end("[{}]");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ stargazers_count: 12 }));
});

let seq = Math.floor(Math.random() * 1e6);
async function account({ login } = {}) {
  const id = String(700000000 + seq++);
  const token = await encode({ token: { raterId: `gh:${id}`, login: login ?? `e2e-${id}`, sub: id }, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600 });
  return { id: `gh:${id}`, cookie: `authjs.session-token=${token}` };
}

function jar(initial = "") {
  const c = new Map(initial ? initial.split("; ").map((kv) => kv.split(/=(.*)/s).slice(0, 2)) : []);
  return {
    header: () => [...c].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [k, v] = sc.split(";")[0].split(/=(.*)/s);
        if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(sc)) c.delete(k);
        else c.set(k, v);
      }
    },
    get: (k) => c.get(k),
  };
}

async function call(j, method, path, body, { origin = BASE, redirect = "follow" } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect,
    headers: { cookie: j.header(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  j.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const grade = JSON.stringify({
  tier: "A",
  quality_score: 4.1,
  checks_score: 71,
  visual_design: { score: 4, note: "Clean type and spacing" },
  writing: { score: 3, note: "Short project blurbs" },
  checks: { resume: true, github: false },
  model: "gemini-3.5-flash-lite",
  judged_at: new Date().toISOString(),
  is_portfolio: true,
});

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/polls`)).ok) break;
    } catch {}
    await sleep(1000);
  }
  await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));
  await ensureRankingSchema(db);
  const stmts = [{ sql: `DELETE FROM site_ratings WHERE url IN (${SITES.map(() => "?").join(",")})`, args: SITES }];
  SITES.forEach((url, i) => {
    for (const [view, rank] of [["merged", i + 1], ["ai", SITES.length - i], ["people", i + 1]]) {
      stmts.push({
        sql: "INSERT INTO site_ratings (view, url, rank, shown_rank, mu, sigma, confidence, tier) VALUES (?, ?, ?, ?, 25, 3, 'confident', 'B')",
        args: [view, url, rank, rank],
      });
    }
  });
  stmts.push(
    { sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?) ON CONFLICT(url) DO UPDATE SET ai_rubric = excluded.ai_rubric", args: [REPORT, grade] },
    { sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?) ON CONFLICT(url) DO UPDATE SET ai_rubric = excluded.ai_rubric", args: [OWNED, grade] },
    { sql: "DELETE FROM cache WHERE k IN ('games:pool', 'stats:site', 'stats:github')", args: [] },
    { sql: "DELETE FROM rate_limits WHERE k LIKE 'quiz-%' OR k LIKE 'badge-event:%' OR k LIKE 'claim:%' OR k LIKE 'owner-action:%' OR k LIKE 'report-email:%'", args: [] }
  );
  await db.batch(stmts, "write");
});

after(async () => {
  await db.execute({ sql: `DELETE FROM site_ratings WHERE url IN (${SITES.map(() => "?").join(",")})`, args: SITES });
  await db.execute("DELETE FROM cache WHERE k = 'games:pool'");
  gh.close();
});

const PERCENT_KEYS = /"(merged|ai|people)"\s*:\s*\d/;

test("Daily 5: the same five for everyone, and no percentile before the guess", async () => {
  const a = await call(jar(), "GET", "/api/games/quiz");
  assert.equal(a.status, 200, a.text);
  assert.match(a.headers.get("cache-control"), /no-store/);
  const quiz = a.body.quiz;
  assert.match(quiz.id, /^daily-\d{4}-\d{2}-\d{2}$/);
  assert.equal(quiz.kind, "daily");
  assert.equal(quiz.rounds.length, 5);
  assert.ok(quiz.rounds.every((r) => SITES.includes(r.url) && r.name && r.path.startsWith("/p/")));
  assert.doesNotMatch(a.text, PERCENT_KEYS);
  const b = await call(jar(), "GET", "/api/games/quiz");
  assert.deepEqual(b.body.quiz.rounds.map((r) => r.url), quiz.rounds.map((r) => r.url));
});

test("guesses: scored on the server, once a round; the fifth finishes and earns First quiz", async () => {
  const j = jar();
  const { quiz } = (await call(j, "GET", "/api/games/quiz")).body;
  const pctOf = (url) => Math.max(1, Math.ceil(((SITES.indexOf(url) + 1) / SITES.length) * 100));
  let last;
  for (const r of quiz.rounds) {
    last = await call(j, "POST", `/api/games/quiz/${quiz.id}/guess`, { index: r.index, guess: pctOf(r.url) });
    assert.equal(last.status, 200, last.text);
    assert.equal(last.body.result.merged, pctOf(r.url));
    assert.equal(last.body.result.points, 100);
    assert.equal(last.body.result.hit, true);
    if (r.index < 4) assert.equal(last.body.finished, null);
  }
  assert.ok(j.get("pr_anon"), "a guest gets the signed practice cookie");
  assert.deepEqual(last.body.finished, { score: 500, hits: 5, perfect: true });
  assert.ok(last.body.badges.includes("quiz") && last.body.badges.includes("perfect"));

  const again = await call(j, "POST", `/api/games/quiz/${quiz.id}/guess`, { index: 0, guess: 1 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_guessed");
  assert.equal(again.body.result.points, 100, "the first guess stands");
  const mine = (await call(j, "GET", `/api/games/quiz/${quiz.id}`)).body.quiz.progress;
  assert.deepEqual([mine.finished, mine.score, mine.hits, mine.results.length], [true, 500, 5, 5]);
});

test("guesses: bad input, forged origin and unknown quizzes are refused", async () => {
  const j = jar();
  const { quiz } = (await call(j, "GET", "/api/games/quiz")).body;
  const path = `/api/games/quiz/${quiz.id}/guess`;
  for (const body of [{ index: 0, guess: 0 }, { index: 0, guess: 101 }, { index: 0, guess: "50" }, { index: 0.5, guess: 50 }, "{nope"]) {
    assert.equal((await call(j, "POST", path, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(j, "POST", path, { index: 9, guess: 50 })).body.error, "bad_index");
  assert.equal((await call(j, "POST", path, { index: 0, guess: 50 }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(j, "POST", path, { index: 0, guess: 50 }, { origin: null })).status, 403);
  assert.equal((await call(j, "POST", "/api/games/quiz/r-zzzzzzzzzz/guess", { index: 0, guess: 50 })).status, 404);
  assert.equal((await call(j, "GET", "/api/games/quiz/not-a-quiz")).status, 404);
});

test("random quizzes: a challenge link replays the same five; new quizzes are rate limited", async () => {
  const j = jar();
  const made = await call(j, "POST", "/api/games/quiz");
  assert.equal(made.status, 201, made.text);
  const quiz = made.body.quiz;
  assert.match(quiz.id, /^r-[A-Za-z0-9_-]{10}$/);
  assert.equal(quiz.challenge, `/play?mode=guess&quiz=${quiz.id}`);
  assert.doesNotMatch(made.text, PERCENT_KEYS);
  const friend = await call(jar(), "GET", `/api/games/quiz/${quiz.id}`);
  assert.deepEqual(friend.body.quiz.rounds.map((r) => r.url), quiz.rounds.map((r) => r.url));
  assert.deepEqual(friend.body.quiz.progress.results, []);
  assert.equal((await call(j, "POST", "/api/games/quiz", undefined, { origin: "https://evil.example" })).status, 403);
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await call(j, "POST", "/api/games/quiz")).status);
  assert.equal(statuses.at(-1), 429);
});

test("badges: earned and locked with progress, told once; events are checked", async () => {
  const j = jar();
  const anon = await call(j, "GET", "/api/badges");
  assert.equal(anon.body.signedIn, false);
  assert.ok(anon.body.badges.length >= 20 && anon.body.badges.every((b) => !b.earned));

  const { quiz } = (await call(j, "GET", "/api/games/quiz")).body;
  for (const r of quiz.rounds) await call(j, "POST", `/api/games/quiz/${quiz.id}/guess`, { index: r.index, guess: 50 });
  const listed = await call(j, "GET", "/api/badges");
  const first = listed.body.badges.find((b) => b.id === "quiz");
  assert.deepEqual([first.earned, first.new, first.progress, first.target], [true, true, 1, 1]);
  const votes = listed.body.badges.find((b) => b.id === "votes10");
  assert.deepEqual([votes.earned, votes.progress, votes.target], [false, 0, 10]);
  assert.equal((await call(j, "GET", "/api/badges")).body.badges.find((b) => b.id === "quiz").new, false);

  const share = await call(j, "POST", "/api/badges", { kind: "share" });
  assert.deepEqual(share.body, { recorded: true, badges: ["share"] });
  assert.equal((await call(j, "POST", "/api/badges", { kind: "visit", url: "https://not-listed.example" })).body.error, "unknown_portfolio");
  assert.equal((await call(j, "POST", "/api/badges", { kind: "vote" })).status, 400);
  assert.equal((await call(j, "POST", "/api/badges", { kind: "visit", url: SITES[1] })).body.recorded, true);
  assert.equal((await call(j, "POST", "/api/badges", { kind: "visit", url: SITES[1] })).body.recorded, false, "visits are distinct");

  const eye = await call(j, "GET", "/api/games/eye");
  assert.equal(eye.status, 200);
  assert.equal(eye.body.eye.guesses.crowd.of, 5);
});

test("sign-in moves a guest's quizzes and badges to the account", async () => {
  const guest = jar();
  const { quiz } = (await call(guest, "GET", "/api/games/quiz")).body;
  for (const r of quiz.rounds) await call(guest, "POST", `/api/games/quiz/${quiz.id}/guess`, { index: r.index, guess: 40 });
  await call(guest, "POST", "/api/badges", { kind: "share" });
  const me = await account();
  const signed = jar(`${me.cookie}; pr_anon=${guest.get("pr_anon")}`);
  const claim = await call(signed, "POST", "/api/claim");
  assert.equal(claim.status, 200, claim.text);
  // On another browser, the account has them.
  const elsewhere = jar(me.cookie);
  const badges = (await call(elsewhere, "GET", "/api/badges")).body;
  assert.equal(badges.signedIn, true);
  assert.ok(badges.badges.find((b) => b.id === "quiz").earned);
  assert.ok(badges.badges.find((b) => b.id === "share").earned);
  assert.equal((await call(elsewhere, "GET", `/api/games/quiz/${quiz.id}`)).body.quiz.progress.finished, true);
});

test("claims: sign-in required, review by the site owner, then owner actions; strangers can't act", async () => {
  assert.equal((await call(jar(), "POST", "/api/owner/claims", { url: OWNED })).status, 401);
  const owner = await account();
  const j = jar(owner.cookie);
  assert.equal((await call(j, "POST", "/api/owner/claims", { url: "https://not-listed.example" })).body.error, "unknown_portfolio");
  assert.equal((await call(j, "POST", "/api/owner/claims", { url: OWNED, method: "manual", note: "x".repeat(501) })).status, 400);
  assert.equal((await call(j, "POST", "/api/owner/claims", { url: OWNED, method: "manual" }, { origin: "https://evil.example" })).status, 403);
  const asked = await call(j, "POST", "/api/owner/claims", { url: OWNED, method: "manual", note: "My site; see the footer." });
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.body.claim.status, "review");
  assert.match(asked.body.claim.meta.tag, /^<meta name="portfoliorank-verify" content="[A-Za-z0-9_-]{16}">$/);
  assert.equal((await call(j, "GET", "/api/owner/claims")).body.claims[0].url, OWNED);
  assert.equal((await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "hide_grade" })).body.error, "not_owner");

  // Only the admin login reviews.
  assert.equal((await call(j, "GET", "/api/admin/claims")).status, 403);
  const admin = jar((await account({ login: "e2e-admin" })).cookie);
  const queue = (await call(admin, "GET", "/api/admin/claims")).body.claims;
  const mine = queue.find((c) => c.url === OWNED && c.owner === owner.id);
  assert.ok(mine);
  assert.equal((await call(admin, "POST", "/api/admin/claims", { id: mine.id, decision: "maybe" })).status, 400);
  assert.equal((await call(admin, "POST", "/api/admin/claims", { id: mine.id, decision: "verified" })).body.claim.status, "verified");
  assert.equal((await call(admin, "POST", "/api/admin/claims", { id: mine.id, decision: "rejected" })).status, 409);

  // The owner hides the grade: the report is the owner's alone.
  assert.deepEqual((await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "hide_grade" })).body.state, { hideGrade: true, removedAt: null });
  const stranger = jar((await account()).cookie);
  assert.equal((await call(stranger, "GET", `/report/print?url=${encodeURIComponent(OWNED)}`)).status, 403);
  assert.equal((await call(j, "GET", `/report/print?url=${encodeURIComponent(OWNED)}`)).status, 200);
  assert.equal((await call(stranger, "POST", "/api/owner/actions", { url: OWNED, action: "remove", confirm: true })).status, 403);

  const regrade = await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "regrade" });
  assert.deepEqual(regrade.body.regrade, { queued: true, pending: true });
  assert.equal((await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "regrade" })).body.regrade.queued, false);
  assert.equal((await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "remove" })).body.error, "confirm_required");
  const removed = await call(j, "POST", "/api/owner/actions", { url: OWNED, action: "remove", confirm: true });
  assert.ok(removed.body.state.removedAt);
  // Gone from the site at once.
  assert.equal((await call(j, "GET", `/report/print?url=${encodeURIComponent(OWNED)}`)).status, 404);
  const log = (await db.execute({ sql: "SELECT action FROM claim_log WHERE url = ? ORDER BY id", args: [OWNED] })).rows.map((r) => String(r.action));
  assert.deepEqual(log.slice(-7), ["claim_started", "claim_review", "claim_verified", "hide_grade", "regrade_requested", "regrade_already_pending", "remove"]);
});

test("live stats: many numbers in one cached answer, GitHub numbers included", async () => {
  const res = await fetch(`${BASE}/api/stats/live`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /public, max-age=60/);
  const s = await res.json();
  for (const k of ["portfolios", "graded", "gradedThisWeek", "votesToday", "votes", "quizzesPlayed", "changedThisMonth"]) assert.equal(typeof s[k], "number", k);
  assert.equal(s.portfolios, feed.length);
  assert.ok(s.graded >= 1);
  assert.ok(s.quizzesPlayed >= 3);
  assert.equal(s.stars, 12);
  assert.equal(s.contributors, 321);
  assert.ok("commonRole" in s && "averageTier" in s && "newest" in s && "ownDomainPct" in s && "resumePct" in s);
});

test("report download: signed in, or a one-time email link; email needs a sender", async () => {
  const path = `/report/print?url=${encodeURIComponent(REPORT)}`;
  const anon = await call(jar(), "GET", path);
  assert.equal(anon.status, 401);
  const me = jar((await account()).cookie);
  const page = await call(me, "GET", path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.ok(page.text.includes("Clean type and spacing") && page.text.includes("@media print"));
  assert.equal((await call(me, "GET", `/report/print?url=${encodeURIComponent("https://not-listed.example")}`)).status, 404);

  // A one-time link opens that one report in that browser, once.
  const token = "e2e".padEnd(43, "x");
  await createReportLink(db, { url: REPORT, token });
  const visitor = jar();
  const open = await call(visitor, "GET", `/report/print?t=${token}`, undefined, { redirect: "manual" });
  assert.equal(open.status, 303);
  assert.equal(open.headers.get("location"), path);
  assert.equal((await call(visitor, "GET", path)).status, 200);
  assert.equal((await call(visitor, "GET", `/report/print?url=${encodeURIComponent(SITES[1])}`)).status, 401, "only that report");
  assert.equal((await call(jar(), "GET", `/report/print?t=${token}`, undefined, { redirect: "manual" })).status, 410);
  // A forged pass is ignored.
  assert.equal((await call(jar(`pr_report=${Date.now() + 9e6}|${REPORT}.${"a".repeat(43)}`), "GET", path)).status, 401);

  const j = jar();
  assert.equal((await call(j, "POST", "/api/report/email", { url: REPORT, email: "not-an-email" })).body.error, "bad_email");
  assert.equal((await call(j, "POST", "/api/report/email", { url: "https://not-listed.example", email: "a@b.dev" })).body.error, "unknown_portfolio");
  assert.equal((await call(j, "POST", "/api/report/email", { url: REPORT, email: "a@b.dev" }, { origin: "https://evil.example" })).status, 403);
  const mail = await call(j, "POST", "/api/report/email", { url: REPORT, email: "a@b.dev" });
  assert.equal(mail.status, 503);
  assert.equal(mail.body.error, "email_unavailable");
});
