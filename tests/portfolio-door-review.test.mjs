// The code review of pull request #238 (the door, lib/reviews/door.mjs): one
// test per finding, each written to fail on the code before its fix. Offline,
// like tests/portfolio-door.test.mjs: a throwaway database, a simulated clock
// and a mocked Gemini; the fallback grader runs as a child process with
// tests/helpers/mock-fetch.mjs, and the nightly feed build runs the real
// pipeline/generate_feed.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema, NOT_PORTFOLIO, syncRoster } from "../pipeline/roster.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { budgetPlan } from "../pipeline/budget.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { SIGNAL_NAMES } from "../pipeline/portfolio-guard.mjs";
import { finishNight, planNight, runBatch, startNight } from "../pipeline/night.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";
import { ensureRubricHistory } from "../pipeline/rubric-history.mjs";
import { planExclusions } from "../pipeline/exclusions.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import { RULE_ACTOR, autoApplyReviews, confirmedRelists, decideReviews, ensureReviewSchema, undoReviews } from "../lib/reviews/store.mjs";
import * as store from "../lib/reviews/store.mjs";
import { syncReviewRows } from "../lib/reviews/door.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
// Page text over the capture's word floor, so a stored capture of it shows the site (lib/reviews/stored-capture.mjs).
import { SITE_TEXT } from "./helpers/door-night.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const T0 = Date.parse("2026-11-17T04:30:00Z"); // 20:30 Pacific on 2026-11-16
const DAY = 86400000;
const answer = (isPortfolio) => ({
  portfolio_reason: isPortfolio ? "Shows projects the person built" : "No work shown",
  is_portfolio: isPortfolio,
  tier: isPortfolio ? "B" : "D",
  ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: isPortfolio ? 3 : 1, note: isPortfolio ? "fine" : `no work shown (${c.id})` }])),
});
const signals = (n) => ({ ...Object.fromEntries(SIGNAL_NAMES.map((k, i) => [k, i < n])), score: n });
const PORTFOLIO_HTML = `<!doctype html><html><head><title>Ann Lee | Engineer</title></head><body><h1>Ann Lee</h1>
  <a href="#projects">Projects</a><a href="#about">About me</a><a href="mailto:a@b.dev">Contact</a><a href="/resume.pdf">Resume</a>
  <a href="https://github.com/annlee">GitHub</a><p>${"I build accessible web apps for small teams. ".repeat(10)}</p></body></html>`;

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-review-"));
  const file = path.join(dir, "db.sqlite");
  const db = createClient({ url: `file:${file}` });
  await ensureRosterSchema(db);
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await ensureRubricHistory(db);
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  return { db, dir, file };
}

let k = 0;
/** A listed, captured site with evidence; `n` signals in its facts, or none at all with n = null. */
async function site(db, url, { name = "Ann Lee", text = SITE_TEXT, n = 2, rubric = null, status = "live", reason = "", needsReview = 0, healthSignals = null, captured = true } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, reason, shot_key, captured_at, ai_rubric, page_text, facts, meta, needs_review, signals)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{"motion":false}', ?, ?)`,
    args: [
      url,
      name,
      status,
      reason,
      captured ? `k${++k}` : null,
      captured ? "2026-11-16 12:00:00" : null,
      rubric == null ? null : JSON.stringify(rubric),
      text,
      JSON.stringify({ source: "http", measured_at: "2026-11-16T00:00:00Z", ...(n == null ? {} : { signals: signals(n) }) }),
      needsReview,
      healthSignals == null ? null : JSON.stringify(healthSignals),
    ],
  });
}

function mockGemini(byUrl) {
  return async (_u, init) => {
    const body = String(init.body);
    const hit = Object.keys(byUrl).find((u) => body.includes(`url: ${u}`));
    const a = hit ? byUrl[hit] : answer(true);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
  };
}

function context(db, { gemini = {}, autoApply = true, start = T0 } = {}) {
  const clock = { t: start };
  return {
    clock,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan("{}"),
      quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
      rpm: 30,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: () => {},
      fetchImpl: mockGemini(gemini),
      image: async () => ({ inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
      flags: { rankingV2: false,reviewAutoApply: autoApply, ranking: rankingConfig({}) },
      runId: "test",
    },
  };
}

async function drive(ctx, clock) {
  let state = await startNight(ctx);
  state = await planNight(ctx, state);
  let steps = 0;
  while (!state.done && steps++ < 200) {
    const r = await runBatch(ctx, state);
    state = r.state;
    if (r.pauseMs) clock.t += r.pauseMs;
  }
  return { state, ...(await finishNight(ctx, state)) };
}

/** The database with some statements made to fail, and every statement counted. */
function faulty(db, { failBatch = () => false, failExecute = () => false } = {}) {
  const seen = [];
  const text = (s) => (typeof s === "string" ? s : s.sql);
  return {
    seen,
    db: new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (s) => {
            seen.push(text(s));
            if (failExecute(text(s))) throw new Error("injected failure");
            return target.execute(s);
          };
        }
        if (prop === "batch") {
          return async (stmts, mode) => {
            for (const s of stmts) seen.push(text(s));
            if (failBatch(stmts.map(text))) throw new Error("injected failure");
            return target.batch(stmts, mode);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };
}

const grade = async (db, url) => {
  const r = (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  return r?.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
const hidden = async (db, url) => Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM portfolios WHERE url = ? AND (${HIDDEN_WHERE})`, args: [url] })).rows[0].n) === 1;
const notPortfolio = async (db, url) => Number((await db.execute({ sql: `SELECT ${NOT_PORTFOLIO()} AS n FROM portfolios WHERE url = ?`, args: [url] })).rows[0].n) === 1;
const reviewsOf = async (db, url) => (await db.execute({ sql: "SELECT * FROM status_reviews WHERE url = ? ORDER BY id", args: [url] })).rows;
const col = async (db, url, c) => (await db.execute({ sql: `SELECT ${c} AS v FROM portfolios WHERE url = ?`, args: [url] })).rows[0]?.v;

test("1: the held grade and its review row are one write: a failure between them leaves neither, and the site is graded again", async () => {
  const { db: real } = await freshDb();
  const url = "https://atomic.dev";
  await site(real, url, { n: 3 });
  // Writing the review row fails (a timeout, a lost connection), however it is sent.
  let failing = true;
  const { db } = faulty(real, {
    failBatch: (sqls) => failing && sqls.some((s) => /INSERT INTO status_reviews/.test(s)),
    failExecute: (s) => failing && /INSERT INTO status_reviews/.test(s),
  });
  const first = context(db, { gemini: { [url]: answer(false) } });
  await drive(first.ctx, first.clock);
  assert.equal(await grade(real, url), null, "no held grade without its row");
  assert.equal((await reviewsOf(real, url)).length, 0);
  // The next night it is graded and removed as usual.
  failing = false;
  const next = context(real, { gemini: { [url]: answer(false) }, start: T0 + DAY });
  await drive(next.ctx, next.clock);
  assert.equal(String((await reviewsOf(real, url))[0].status), "auto_applied");
  assert.equal(await hidden(real, url), true);
});

test("1: when the rule's apply fails after the write, the row waits pending and the hourly rule applies it", async () => {
  const { db: real } = await freshDb();
  const url = "https://apply-fails.dev";
  await site(real, url, { n: 3 });
  const { db } = faulty(real, { failExecute: (s) => /SET status = 'auto_applied'/.test(s) });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  await drive(ctx, clock);
  const [row] = await reviewsOf(real, url);
  assert.equal(String(row.status), "pending", "the row exists with the held grade");
  assert.equal((await grade(real, url)).ai_is_portfolio, false);
  const applied = await autoApplyReviews(real, { onFeed: () => true, now: new Date(clock.t + 3600000) });
  assert.deepEqual(applied.map((r) => r.ok), [true]);
  assert.equal(await hidden(real, url), true);
});

/** pipeline/judge.mjs rubric as the fallback grader runs it, offline. */
function runJudge(dir, dbFile, gemini) {
  const r = spawnSync(process.execPath, ["--import", "./tests/helpers/mock-fetch.mjs", "pipeline/judge.mjs", "rubric", "--rpm", "60000", "--no-browser"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${dbFile}`,
      TURSO_AUTH_TOKEN: "",
      GEMINI_API_KEY: "test-key-not-real",
      SHOTS_BASE_URL: "https://shots.test",
      GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
      MOCK_GEMINI: JSON.stringify(gemini),
    },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("2: the fallback grader (judge.mjs rubric) goes through the door: a 'no' is held with a row, never removed silently", async () => {
  const { db, dir, file } = await freshDb();
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
  const url = feed[0].url;
  await site(db, url, { n: 2 });
  const r = runJudge(dir, file, [{ json: answer(false) }]);
  assert.equal(r.code, 0, r.out);
  const [row] = await reviewsOf(db, url);
  assert.ok(row, `a review row is written\n${r.out}`);
  assert.equal(String(row.grp), "door_not_portfolio");
  assert.equal(String(row.status), "pending", "the fallback never applies a removal itself; the hourly rule does");
  const g = await grade(db, url);
  assert.deepEqual([g.is_portfolio, g.ai_is_portfolio], [true, false]);
  assert.equal(await notPortfolio(db, url), false);
});

test("2: on the fallback grader a 'no' against the both-pass rule's relist is held for the owner, not flipped back", async () => {
  const { db, dir, file } = await freshDb();
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
  const url = feed[1].url;
  await site(db, url, { n: 2 });
  await ensureReviewSchema(db);
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, decided_at, decided_by, created_at)
          VALUES ('recheck-543', ?, 'not_portfolio', 'listed', 'relist', 1, '{}', 'auto_applied', '2026-11-15T00:00:00Z', ?, '2026-11-14T00:00:00Z')`,
    args: [url, RULE_ACTOR],
  });
  const r = runJudge(dir, file, [{ json: answer(false) }]);
  assert.equal(r.code, 0, r.out);
  const rows = await reviewsOf(db, url);
  assert.equal(String(rows.at(-1).grp), "door_held");
  assert.equal((await grade(db, url)).is_portfolio, true, "still listed");
});

test("2: the finished regrade-not-portfolio one-off refuses to write grades", async () => {
  const { file } = await freshDb();
  const r = spawnSync(process.execPath, ["scripts/regrade-not-portfolio.mjs"], {
    cwd: ROOT,
    env: { ...process.env, TURSO_DATABASE_URL: `file:${file}`, TURSO_AUTH_TOKEN: "", GEMINI_API_KEY: "test-key-not-real" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /finished one-off and refuses to write/);
});

test("3: a removal stays down with its reason when the weekly check sees an error or a duplicate", async () => {
  const { db } = await freshDb();
  const a = "https://removed-error.dev";
  const b = "https://removed-dup.dev";
  await site(db, a, { n: 2 });
  await site(db, b, { n: 2 });
  const { ctx, clock } = context(db, { gemini: { [a]: answer(false), [b]: answer(false) } });
  await drive(ctx, clock);
  const reason = String(await col(db, a, "health_reason"));
  assert.equal(reason, "AI grading says this is not a portfolio");
  // a answers 500; b's address is a duplicate of an entry listed before it.
  const fetchImpl = async (u) =>
    String(u).includes("removed-error") ? { status: 500, ok: false, url: u, text: async () => "" } : { status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML };
  const feed = [
    { url: "https://www.removed-dup.dev/", name: "First" },
    { url: a, name: "Ann Lee" },
    { url: b, name: "Ann Lee" },
  ];
  await runHealthCheck({ db, feed, fetchImpl, log: () => {}, now: new Date(T0 + 4 * DAY) });
  for (const u of [a, b]) {
    assert.equal(String(await col(db, u, "health")), "down", u);
    assert.equal(String(await col(db, u, "health_reason")), reason, u);
    assert.equal(String(await col(db, u, "health_fails")) !== "0", true, u);
    assert.equal(await hidden(db, u), true, u);
  }
});

test("4: a collapsed-signals case the owner rejected, or a site he confirmed is a portfolio, is not reopened every week", async () => {
  const { db } = await freshDb();
  const kept = "https://kept-by-owner.dev";
  const confirmed = "https://confirmed-portfolio.dev";
  const g = { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, rubric_version: 2, judged_at: "2026-10-01T00:00:00.000Z" };
  const collapsedSignals = (at) => ({ ...signals(1), checked_at: at });
  await site(db, kept, { rubric: g, needsReview: 1, healthSignals: collapsedSignals("2026-11-16T10:00:00.000Z") });
  await site(db, confirmed, { rubric: g, needsReview: 1, healthSignals: collapsedSignals("2026-11-16T10:00:00.000Z") });
  await ensureReviewSchema(db);
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, decided_at, decided_by, created_at)
          VALUES ('recheck-543', ?, 'not_portfolio', 'listed', 'relist', 1, '{}', 'confirmed', '2026-11-12T00:00:00Z', 'admin:owner', '2026-11-11T00:00:00Z')`,
    args: [confirmed],
  });
  const first = await syncReviewRows(db, { now: new Date(T0) });
  assert.deepEqual(first.collapsed, [kept], "an owner-confirmed portfolio gets no collapse row");
  const [row] = await reviewsOf(db, kept);
  await decideReviews(db, { ids: [Number(row.id)], action: "reject", actor: "admin:owner", onFeed: () => true, now: new Date(T0 + 3600000) });
  // Next week's health check finds the signals collapsed again.
  for (const u of [kept, confirmed]) {
    await db.execute({ sql: "UPDATE portfolios SET signals = ?, needs_review = 1 WHERE url = ?", args: [JSON.stringify(collapsedSignals("2026-11-23T10:00:00.000Z")), u] });
  }
  const again = await syncReviewRows(db, { now: new Date(T0 + 7 * DAY) });
  assert.deepEqual(again.collapsed, [], "settled by the owner");
});

test("5: a waiting removal is closed, not applied, when a newer decision made it stale", async () => {
  const { db } = await freshDb();
  const later = "https://graded-again.dev";
  const owner = "https://owner-decided.dev";
  await site(db, later, { n: 2 });
  await site(db, owner, { n: 2 });
  const { ctx, clock } = context(db, { gemini: { [later]: answer(false), [owner]: answer(false) }, autoApply: false });
  await drive(ctx, clock);
  // A later grade says portfolio; the owner decides on the other site himself.
  await db.execute({
    sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
    args: [JSON.stringify({ ...answer(true), model: PRIMARY_MODEL, judged_at: new Date(T0 + DAY).toISOString() }), later],
  });
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, decided_at, decided_by, created_at)
          VALUES ('owner-list', ?, 'not_portfolio', 'listed', 'relist', 1, '{}', 'confirmed', ?, 'admin:owner', ?)`,
    args: [owner, new Date(T0 + DAY).toISOString(), new Date(T0 + DAY).toISOString()],
  });
  const res = await autoApplyReviews(db, { onFeed: () => true, now: new Date(T0 + 2 * DAY) });
  assert.equal(res.filter((r) => r.ok).length, 0, "nothing applied");
  for (const u of [later, owner]) {
    const door = (await reviewsOf(db, u)).find((r) => String(r.grp) === "door_not_portfolio");
    assert.equal(String(door.status), "closed", u);
    assert.ok(JSON.parse(String(door.applied)).closed, "the reason is recorded");
    assert.equal(await hidden(db, u), false, u);
  }
  assert.ok((await store.listReviews(db)).decided.some((r) => r.status === "closed"), "closed rows are listed for the owner");
});

test("6: a 'no' on a site whose signals were never measured goes to the owner, never to automatic removal", async () => {
  const { db } = await freshDb();
  const url = "https://never-measured.dev";
  await site(db, url, { n: null });
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  await drive(ctx, clock);
  const [row] = await reviewsOf(db, url);
  assert.equal(String(row.status), "pending");
  assert.equal(String(row.grp), "door_held");
  assert.match(String(row.reason), /never measured/);
  assert.equal(await hidden(db, url), false);
});

test("7: the owner's Reject settles a held grade: the weekly check no longer re-flags it and its text is his decision", async () => {
  const { db } = await freshDb();
  const strong = "https://strong-kept.dev";
  const removed = "https://undone-then-kept.dev";
  await site(db, strong, { n: 5 });
  await site(db, removed, { n: 2 });
  const { ctx, clock } = context(db, { gemini: { [strong]: answer(false), [removed]: answer(false) } });
  await drive(ctx, clock);
  const at = (h) => new Date(clock.t + h * 3600000);
  const [s] = await reviewsOf(db, strong);
  const [rm] = await reviewsOf(db, removed);
  await undoReviews(db, { ids: [Number(rm.id)], actor: "admin:owner", now: at(1) });
  await decideReviews(db, { ids: [Number(s.id), Number(rm.id)], action: "reject", actor: "admin:owner", onFeed: () => true, now: at(2) });
  for (const u of [strong, removed]) {
    const g = await grade(db, u);
    assert.equal(g.review.kind, "owner_kept", u);
    assert.doesNotMatch(g.review.reason, /rule takes it off|Removed automatically/i, u);
    assert.equal(Number(await col(db, u, "needs_review")), 0, u);
  }
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML });
  await runHealthCheck({ db, feed: [{ url: strong, name: "Ann Lee" }, { url: removed, name: "Ann Lee" }], fetchImpl, log: () => {}, now: new Date(T0 + 3 * DAY) });
  assert.equal(Number(await col(db, strong, "needs_review")), 0, "not re-flagged");
  assert.equal(await hidden(db, removed), false);
});

test("8: a bot-wall row only for a never-captured site, by the capture's own reason", async () => {
  const { db } = await freshDb();
  const never = "https://never-captured.dev";
  const before = "https://captured-before.dev";
  await site(db, never, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  await site(db, before, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, rubric: { tier: "B", is_portfolio: true, model: PRIMARY_MODEL, judged_at: "2026-10-01T00:00:00Z" } });
  const r = await syncReviewRows(db, { now: new Date(T0) });
  assert.deepEqual(r.botWall, [never]);
});

test("9: the night ensures the review schema once, not for every graded site", async () => {
  const { db: real } = await freshDb();
  for (let i = 0; i < 6; i++) await site(real, `https://many-${i}.dev`, { n: 2 });
  const { db, seen } = faulty(real);
  const { ctx, clock } = context(db, { gemini: Object.fromEntries([...Array(6)].map((_, i) => [`https://many-${i}.dev`, answer(i % 2 === 0)])) });
  await drive(ctx, clock);
  const creates = seen.filter((s) => /CREATE TABLE IF NOT EXISTS status_reviews/.test(s)).length;
  assert.ok(creates <= 2, `created the review table ${creates} times for 6 sites`);
});

// The nightly feed build as sync-upstream.yml runs it: review-additions, then generate_feed.py, then the roster sync.
function nightlySync(db, dir, { readme }) {
  const file = (f) => path.join(dir, f);
  const read = (f, d) => (fs.existsSync(file(f)) ? JSON.parse(fs.readFileSync(file(f), "utf8")) : d);
  return (async () => {
    const plan = planReviewAdditions({
      relists: await confirmedRelists(db),
      // (Absent before the fix: the sync then knew only confirmed relists.)
      undone: store.undoneRemovals ? await store.undoneRemovals(db) : [],
      additions: read("additions.json", []),
      excluded: read("excluded.json", []),
      feed: read("feed.json", []),
    });
    fs.writeFileSync(file("additions.json"), JSON.stringify(plan.additions));
    fs.writeFileSync(file("excluded.json"), JSON.stringify(plan.excluded));
    execFileSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), readme, file("feed.json"), "--exclude", file("excluded.json"), "--add", file("additions.json")], { stdio: "pipe" });
    const feed = read("feed.json", []);
    await syncRoster(db, feed);
    return feed;
  })();
}

// The weekly export as health.yml runs it (after the health check): confirmed-down sites into excluded.json, off the feed.
async function weeklyExport(db, dir, now) {
  const file = (f) => path.join(dir, f);
  const plan = await planExclusions({ db, excluded: JSON.parse(fs.readFileSync(file("excluded.json"), "utf8")), feed: JSON.parse(fs.readFileSync(file("feed.json"), "utf8")), now });
  fs.writeFileSync(file("excluded.json"), JSON.stringify(plan.excluded));
  fs.writeFileSync(file("feed.json"), JSON.stringify(plan.feed));
  return plan.added.map((a) => a.url);
}

async function listedWorld(url) {
  const { db, dir } = await freshDb();
  const readme = path.join(dir, "README.md");
  const lines = [...Array(520)].map((_, i) => `- [Filler ${i}](https://filler-${i}.dev) [Developer]`);
  lines.push(`- [Ann Lee](${url}) [Developer]`);
  fs.writeFileSync(readme, `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "excluded.json"), "[]");
  fs.writeFileSync(path.join(dir, "additions.json"), "[]");
  execFileSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), readme, path.join(dir, "feed.json"), "--exclude", path.join(dir, "excluded.json"), "--add", path.join(dir, "additions.json")], { stdio: "pipe" });
  await site(db, url, { n: 2 });
  await syncRoster(db, JSON.parse(fs.readFileSync(path.join(dir, "feed.json"), "utf8")));
  const { ctx, clock } = context(db, { gemini: { [url]: answer(false) } });
  await drive(ctx, clock);
  assert.equal(await hidden(db, url), true, "removed by the rule");
  return { db, dir, readme, clock };
}

const listed = async (db, url, feed) => {
  assert.ok(feed.some((p) => p.url === url), "on the feed");
  assert.equal(await col(db, url, "delisted_at"), null, "listed in the roster");
  assert.equal(await hidden(db, url), false, "shown");
  assert.equal(await notPortfolio(db, url), false, "in the tiers and boards");
};

test("10: Undo before the weekly export: the site never leaves the feed and is listed after the nightly sync", async () => {
  const url = "https://undo-before.dev";
  const { db, dir, readme, clock } = await listedWorld(url);
  const [row] = await reviewsOf(db, url);
  await undoReviews(db, { ids: [Number(row.id)], actor: "admin:owner", now: new Date(clock.t + 3600000) });
  assert.deepEqual(await weeklyExport(db, dir, new Date(clock.t + 3 * DAY)), [], "nothing to export after the undo");
  await listed(db, url, await nightlySync(db, dir, { readme }));
});

test("10: Undo after the weekly export: the next nightly sync brings the site back from excluded.json onto the list", async () => {
  const url = "https://undo-after.dev";
  const { db, dir, readme, clock } = await listedWorld(url);
  assert.deepEqual(await weeklyExport(db, dir, new Date(clock.t + 3 * DAY)), [url], "exported as not a portfolio");
  const off = await nightlySync(db, dir, { readme });
  assert.ok(!off.some((p) => p.url === url), "off the feed");
  assert.ok(await col(db, url, "delisted_at"), "delisted");
  const [row] = await reviewsOf(db, url);
  const [u] = await undoReviews(db, { ids: [Number(row.id)], actor: "admin:owner", now: new Date(clock.t + 4 * DAY) });
  assert.equal(u.ok, true, JSON.stringify(u));
  const feed = await nightlySync(db, dir, { readme });
  await listed(db, url, feed);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, "excluded.json"), "utf8")).some((e) => e.url === url), "out of excluded.json");
  // And it stays listed on the sync after that (the additions entry is ours and is kept).
  await listed(db, url, await nightlySync(db, dir, { readme }));
});
