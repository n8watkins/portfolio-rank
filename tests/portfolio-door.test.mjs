// "Is it a portfolio" is asked once, at the door (owner, 2026-11-16;
// lib/reviews/door.mjs, docs/DECISIONS.md), and the grading audit's findings:
//   F1  a Gemini "no" removes the site with a record and an Undo
//   F5  a "no" against strong code signals goes to the owner; a junk rule is not guarded
//   F6  a rule's verdict is labelled the rule's, never the owner's
//   F2  no automatic re-grading by default
//   F4  a missing-screenshot marker does not lose a new site for good
//   F9  a stalled Gemini cannot run a batch past the Workflow's step limit
//   F10 the night says which sites it touched
// Offline, like tests/night.test.mjs: a throwaway database, a simulated clock
// and a mocked Gemini; `drive` does what the Workflow does (worker/night.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ensureRosterSchema, NOT_PORTFOLIO } from "../pipeline/roster.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { DEFAULT_PLAN, budgetPlan } from "../pipeline/budget.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL, BACKUP_MODEL } from "../pipeline/gemini.mjs";
import { AI_CRITERIA, gradeRecord } from "../pipeline/rubric.mjs";
import { SIGNAL_NAMES } from "../pipeline/portfolio-guard.mjs";
import { finishNight, planNight, runBatch, startNight } from "../pipeline/night.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";
import { ensureRubricHistory } from "../pipeline/rubric-history.mjs";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import {
  DOOR_RULE_ACTOR,
  OWNER_KIND,
  RULE_ACTOR,
  RULE_KIND,
  autoApplyReviews,
  decideReviews,
  ensureReviewSchema,
  listReviews,
  ownerGrade,
  ownerVerdict,
  undoReviews,
} from "../lib/reviews/store.mjs";
import { doorDecision } from "../lib/reviews/door.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
// Page text over the capture's word floor, so a stored capture of it shows the site (lib/reviews/stored-capture.mjs).
import { SITE_TEXT } from "./helpers/door-night.mjs";

// A grade with the owner's verdict applied, as the door does (doorDecision).
const withOwnerVerdict = async (db, url, grade) => ownerGrade(grade, await ownerVerdict(db, url));

const T0 = Date.parse("2026-11-17T04:30:00Z"); // 20:30 Pacific on 2026-11-16
const DAY = 86400000;
const answer = (isPortfolio, over = {}) => ({
  portfolio_reason: isPortfolio ? "Shows projects the person built" : "no work shown on the page",
  is_portfolio: isPortfolio,
  tier: isPortfolio ? "B" : "D",
  ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: isPortfolio ? 3 : 1, note: isPortfolio ? "fine" : `no work shown (${c.id})` }])),
  ...over,
});
const signals = (n) => ({ ...Object.fromEntries(SIGNAL_NAMES.map((k, i) => [k, i < n])), score: n });
const JOHN_DOE = "John Doe. Lorem ipsum dolor sit amet. Projects. About me. Contact. Resume. GitHub.";
const PORTFOLIO_HTML = `<!doctype html><html><head><title>Ann Lee | Engineer</title></head><body><h1>Ann Lee</h1>
  <a href="#projects">Projects</a><a href="#about">About me</a><a href="mailto:a@b.dev">Contact</a><a href="/resume.pdf">Resume</a>
  <a href="https://github.com/annlee">GitHub</a><p>${"I build accessible web apps for small teams. ".repeat(10)}</p></body></html>`;

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "door-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureGeminiLog(db);
  await ensureRankingSchema(db);
  await ensureRubricHistory(db);
  await db.execute(`CREATE TABLE votes (id INTEGER PRIMARY KEY AUTOINCREMENT, winner TEXT NOT NULL, loser TEXT NOT NULL,
       pair_key TEXT, rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), delta INTEGER, starred INTEGER NOT NULL DEFAULT 0, model TEXT)`);
  return db;
}

let k = 0;
/** A listed, captured site with evidence. */
async function site(db, url, { name = "Ann Lee", text = SITE_TEXT, n = 2, rubric = null, capturedAt = "2026-11-16 12:00:00", status = "live", reason = "", needsReview = 0, healthSignals = null } = {}) {
  const key = `k${++k}`;
  await db.execute({
    sql: `INSERT INTO portfolios (url, name, status, reason, shot_key, captured_at, ai_rubric, page_text, facts, meta, needs_review, signals)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      url,
      name,
      status,
      reason,
      status === "live" ? key : null,
      capturedAt,
      rubric == null ? null : JSON.stringify(rubric),
      text,
      JSON.stringify({ source: "http", measured_at: "2026-11-16T00:00:00Z", signals: signals(n) }),
      JSON.stringify({ motion: false }),
      needsReview,
      healthSignals == null ? null : JSON.stringify(healthSignals),
    ],
  });
  return key;
}

// Gemini's answer per site (by the url in the request); "bad" answers malformed JSON.
function mockGemini(byUrl, { onCall } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = String(init.body);
    calls.push(body);
    const hit = Object.keys(byUrl).find((u) => body.includes(`url: ${u}`));
    const a = hit ? byUrl[hit] : answer(true);
    const step = await onCall?.(calls.length - 1);
    if (step) return step;
    const text = a === "bad" ? "{not json" : JSON.stringify(a);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

function context(db, { gemini, autoApply = true, budget = {}, missing = new Set(), start = T0 } = {}) {
  const clock = { t: start };
  const lines = [];
  return {
    clock,
    lines,
    ctx: {
      db,
      apiKey: "test-key-not-real",
      plan: budgetPlan(JSON.stringify(budget)),
      quota: { [PRIMARY_MODEL]: 500, [BACKUP_MODEL]: 500 },
      rpm: 30,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      log: (l) => lines.push(l),
      fetchImpl: gemini.fetchImpl,
      image: async (key) => (missing.has(key) ? "missing" : { inline_data: { mime_type: "image/jpeg", data: "AAAA" } }),
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

const grade = async (db, url) => {
  const r = (await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  return r?.ai_rubric == null ? null : JSON.parse(String(r.ai_rubric));
};
const hidden = async (db, url) => Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM portfolios WHERE url = ? AND (${HIDDEN_WHERE})`, args: [url] })).rows[0].n) === 1;
const notPortfolio = async (db, url) => Number((await db.execute({ sql: `SELECT ${NOT_PORTFOLIO()} AS n FROM portfolios WHERE url = ?`, args: [url] })).rows[0].n) === 1;
const reviewsOf = async (db, url) => (await db.execute({ sql: "SELECT * FROM status_reviews WHERE url = ? ORDER BY id", args: [url] })).rows;
const col = async (db, url, c) => (await db.execute({ sql: `SELECT ${c} AS v FROM portfolios WHERE url = ?`, args: [url] })).rows[0].v;

test("F1: a Gemini 'no' with 3 signals is removed automatically, with a record the owner sees, and Undo puts it back for good", async () => {
  const db = await freshDb();
  const url = "https://three-signals.dev";
  await site(db, url, { n: 3 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }) });
  const night = await drive(ctx, clock);
  assert.equal(night.status, "complete");

  // The record: an automatically applied removal by the door's own rule, with Gemini's reason, the signals and the screenshot.
  const [row] = await reviewsOf(db, url);
  assert.ok(row, "a status_reviews row is written");
  assert.equal(String(row.status), "auto_applied");
  assert.equal(String(row.decided_by), DOOR_RULE_ACTOR);
  assert.notEqual(DOOR_RULE_ACTOR, RULE_ACTOR, "never confused with the both-pass rule");
  assert.equal(String(row.grp), "door_not_portfolio");
  assert.equal(String(row.proposed), "remove");
  assert.match(String(row.reason), /Gemini said this is not a portfolio; the code found 3 of 6/);
  assert.match(String(row.reason), /no work shown/, "Gemini's own notes");
  assert.equal(JSON.parse(String(row.signals)).score, 3);
  assert.ok(row.shot_key, "the screenshot it was judged on");
  const listed = await listReviews(db);
  assert.deepEqual(listed.autoApplied.map((r) => r.url), [url], "shown in the automatically-applied list");

  // Removed: hidden at once, not a portfolio for tiers, boards and the sitemap.
  assert.equal(await hidden(db, url), true);
  assert.equal(await notPortfolio(db, url), true);

  // Undo: back as it was (listed), the row waits for the owner.
  const [undo] = await undoReviews(db, { ids: [Number(row.id)], actor: "admin:owner", now: new Date(clock.t + 3600000) });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(await hidden(db, url), false);
  assert.equal(await notPortfolio(db, url), false);
  // The "no" grade's scores are not shown as its grade: it waits for one fresh grade after a new capture
  // (the review of #238, finding b; tests/portfolio-door-stored-capture.test.mjs).
  const g = await grade(db, url);
  assert.equal(g.error, "fresh_grade_due");
  assert.equal(String((await reviewsOf(db, url))[0].status), "pending");

  // The rule never removes it again: not the hourly apply...
  assert.deepEqual(await autoApplyReviews(db, { onFeed: () => true, now: new Date(clock.t + 2 * 3600000) }), []);
  // ...and not the next night, when the site is graded again after a new capture and Gemini still says no.
  await db.execute({ sql: "UPDATE portfolios SET captured_at = '2026-11-17 12:00:00' WHERE url = ?", args: [url] });
  const next = context(db, { gemini: mockGemini({ [url]: answer(false) }), start: T0 + DAY });
  const again = await drive(next.ctx, next.clock);
  assert.equal(again.summary.stages.find((s) => s.key === "grade_new").done, 1, "graded again");
  assert.equal((await grade(db, url)).ai_is_portfolio, false, "Gemini's answer is kept");
  assert.equal(await hidden(db, url), false, "still listed");
  assert.equal(await notPortfolio(db, url), false);
  // One open case, no new removal: the undone row is replaced by the new grade's held row.
  assert.deepEqual((await reviewsOf(db, url)).map((r) => [String(r.status), String(r.grp)]), [["closed", "door_not_portfolio"], ["pending", "door_held"]]);
});

test("F5: a Gemini 'no' with 4 or more signals stays listed with a pending row, and the weekly health check does not erase it", async () => {
  const db = await freshDb();
  const url = "https://ann-lee.dev";
  await site(db, url, { n: 5 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }) });
  await drive(ctx, clock);
  const [row] = await reviewsOf(db, url);
  assert.ok(row, "a review row for the owner");
  assert.equal(String(row.status), "pending");
  assert.equal(String(row.grp), "door_strong_signals");
  assert.match(String(row.reason), /the code found 5 of 6/);
  assert.equal(await hidden(db, url), false);
  assert.equal(await notPortfolio(db, url), false, "stays listed and ranked");
  assert.equal(Number(await col(db, url, "needs_review")), 1);

  // The weekly health check finds a healthy portfolio page: the mark and the case stay.
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML });
  await runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }], fetchImpl, log: () => {}, now: new Date(T0 + 3 * DAY) });
  assert.equal(Number(await col(db, url, "needs_review")), 1, "the health check no longer erases a pending case");
  assert.equal(String((await reviewsOf(db, url))[0].status), "pending");
  assert.equal(String(await col(db, url, "health")), "live");
});

test("F5: a junk-rule hit is not protected by the guard: a 'John Doe' starter with 6 of 6 signals is removed", async () => {
  // The guard alone (gradeRecord) keeps it listed: 6 signals.
  const kept = gradeRecord({ parsed: answer(false), model: PRIMARY_MODEL, facts: { signals: signals(6) }, source: "r2" });
  assert.equal(kept.is_portfolio, true);
  const db = await freshDb();
  const url = "https://starter-template.dev";
  await site(db, url, { name: "Portfolio", text: JOHN_DOE, n: 6 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }) });
  await drive(ctx, clock);
  const [row] = await reviewsOf(db, url);
  assert.equal(String(row.status), "auto_applied");
  assert.equal(JSON.parse(String(row.signals)).junk_rule, "placeholder name");
  assert.match(String(row.reason), /junk rule fired \(placeholder name\)/);
  assert.equal(await hidden(db, url), true);
});

test("F6: a rule's verdict is stored and shown as the rule's, and only the owner's own decision holds over later grades", async () => {
  const db = await freshDb();
  const url = "https://ruled-out.dev";
  await site(db, url, { n: 1 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }) });
  await drive(ctx, clock);
  const g = await grade(db, url);
  assert.equal(g.is_portfolio, false);
  assert.equal(g.review.kind, RULE_KIND);
  assert.notEqual(g.review.kind, OWNER_KIND);
  assert.doesNotMatch(g.review.reason, /owner confirmed/i);
  assert.match(g.review.reason, new RegExp(DOOR_RULE_ACTOR));
  assert.equal(await ownerVerdict(db, url), null, "a rule's apply is not the owner's verdict");
  const later = answer(true);
  assert.equal((await withOwnerVerdict(db, url, later)).is_portfolio, true, "nothing the owner said binds a later grade");

  // The owner's own decision does: undo, then confirm the removal himself.
  const [row] = await reviewsOf(db, url);
  await undoReviews(db, { ids: [Number(row.id)], actor: "admin:owner", now: new Date(clock.t + 1000) });
  const [d] = await decideReviews(db, { ids: [Number(row.id)], action: "confirm", actor: "admin:owner", onFeed: () => true, now: new Date(clock.t + 2000) });
  assert.equal(d.ok, true);
  assert.equal((await grade(db, url)).review.kind, OWNER_KIND);
  assert.equal((await ownerVerdict(db, url)).isPortfolio, false);
  assert.equal((await withOwnerVerdict(db, url, later)).is_portfolio, false);
});

test("F6: what a rule decided before is weighed at the door: a later 'no' against it waits for the owner, never removed by a rule", () => {
  const row = { url: "https://weighed.dev", name: "Ann Lee", page_text: "Hi, I build things.", facts: JSON.stringify({ signals: signals(2) }) };
  const no = gradeRecord({ parsed: answer(false), model: PRIMARY_MODEL, facts: { signals: signals(2) }, source: "r2" });
  assert.equal(doorDecision({ grade: no, row }).outcome, "remove", "no earlier decision: the rule removes it");
  const afterRule = doorDecision({ grade: no, row, rule: { isPortfolio: true, by: RULE_ACTOR, at: "2026-11-14T10:00:00Z" } });
  assert.deepEqual([afterRule.outcome, afterRule.group, afterRule.grade.is_portfolio], ["held", "door_held", true]);
  assert.match(afterRule.why, /rule:both-pass/);
  const regrade = doorDecision({ grade: no, row, previous: { tier: "B", is_portfolio: true, judged_at: "2026-10-01T00:00:00Z" } });
  assert.equal(regrade.outcome, "held", "a re-grade's 'no' on a site graded a portfolio is never removed by the rule");
  assert.equal(doorDecision({ grade: no, row, takenBack: true }).outcome, "held");
  const owner = doorDecision({ grade: no, row, owner: { isPortfolio: true, by: "admin:owner", at: "2026-11-15T00:00:00Z", batch: "b" } });
  assert.deepEqual([owner.outcome, owner.grade.is_portfolio, owner.grade.review.kind], ["owner", true, OWNER_KIND]);
  assert.equal(doorDecision({ grade: gradeRecord({ parsed: answer(true), model: PRIMARY_MODEL, facts: null, source: "r2" }), row }).outcome, "portfolio");
});

test("F2: no stage re-grades automatically, and no GEMINI_BUDGET brings one back", () => {
  assert.equal(DEFAULT_PLAN.stages.grade_changed, undefined);
  assert.equal(DEFAULT_PLAN.stages.regrade, undefined);
  const on = budgetPlan(JSON.stringify({ stages: { grade_new: { cap: 10 }, grade_changed: { cap: 100 }, regrade: { cap: 300 } } }));
  assert.equal(on.stages.grade_changed, undefined, "the removed stages stay removed");
  assert.equal(on.stages.regrade, undefined);
});

test("F9: a stalled Gemini ends the batch within the wall-clock limit, and the night goes on", async () => {
  const db = await freshDb();
  for (let i = 0; i < 12; i++) await site(db, `https://slow-${i}.dev`, { n: 3 });
  const { ctx, clock } = context(db, {
    // Every request hangs until the 60 s timeout.
    gemini: mockGemini({}, {
      onCall: async () => {
        clock.t += 60000;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    }),
    budget: { retryBudget: 1000 },
  });
  let state = await startNight(ctx);
  state = await planNight(ctx, state);
  const before = clock.t;
  const r = await runBatch(ctx, state);
  const minutes = (clock.t - before) / 60000;
  assert.ok(minutes < 20, `the batch took ${minutes.toFixed(1)} min of the Workflow's 20`);
  assert.equal(r.state.done, false, "the batch returned normally; the night goes on");
  assert.equal(r.state.stage?.key, "grade_new", "the stage is still open for the next batch");
  assert.ok(r.state.stage.batchCapped >= 1);
  assert.equal(DEFAULT_PLAN.batchMinutes, 10);
  assert.equal(DEFAULT_PLAN.requestTimeoutSeconds, 60);
});

test("an owner's confirmed removal stays off the list through the next weekly health check (it was turned 'suspect' and shown again)", async () => {
  const db = await freshDb();
  const url = "https://owner-removed.dev";
  await site(db, url, { n: 2, rubric: { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, rubric_version: 2, judged_at: "2026-11-01T00:00:00.000Z" } });
  await ensureReviewSchema(db);
  const id = Number(
    (
      await db.execute({
        sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('t', ?, 'not_portfolio', 'listed', 'remove', 1, '{}', '2026-11-16T00:00:00Z')`,
        args: [url],
      })
    ).lastInsertRowid
  );
  const [d] = await decideReviews(db, { ids: [id], action: "confirm", actor: "admin:owner", onFeed: () => true, now: new Date(T0) });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(await hidden(db, url), true);
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML });
  await runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }], fetchImpl, log: () => {}, now: new Date(T0 + 4 * DAY) });
  assert.equal(String(await col(db, url, "health")), "down");
  assert.match(String(await col(db, url, "health_reason")), /confirmed by the owner/);
  assert.equal(await hidden(db, url), true);
});

test("one night over a mixed set of new sites: every outcome, the summary lists them, requests name their site", async () => {
  const db = await freshDb();
  const S = {
    yes: "https://yes.dev",
    no3: "https://no-three.dev",
    no5: "https://no-five.dev",
    junk: "https://john-doe.dev",
    recaptured: "https://recaptured.dev",
    waiting: "https://waiting.dev",
    missing: "https://missing-now.dev",
    bad: "https://bad-answer.dev",
    walled: "https://walled.dev",
    collapsed: "https://collapsed.dev",
  };
  await site(db, S.yes, { n: 6 });
  await site(db, S.no3, { n: 3 });
  await site(db, S.no5, { n: 5 });
  await site(db, S.junk, { name: "Portfolio", text: JOHN_DOE, n: 6 });
  // Its screenshot was missing on an earlier night; it was captured again since: graded tonight.
  await site(db, S.recaptured, { rubric: { error: "no_usable_captures", judged_at: "2026-11-10T04:40:00.000Z" }, capturedAt: "2026-11-15 03:00:00" });
  // Marked after its last capture: waits for a newer one, never asked for tonight.
  await site(db, S.waiting, { rubric: { error: "no_usable_captures", judged_at: "2026-11-15T04:40:00.000Z" }, capturedAt: "2026-11-14 03:00:00" });
  const missingKey = await site(db, S.missing);
  await site(db, S.bad);
  // Pull request #235's marker: never captured, a bot wall.
  await site(db, S.walled, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, capturedAt: null });
  // Listed and graded a portfolio long ago; this week's health check found 1 signal.
  await site(db, S.collapsed, {
    rubric: { tier: "C", is_portfolio: true, model: PRIMARY_MODEL, rubric_version: 2, judged_at: "2026-10-01T00:00:00.000Z" },
    needsReview: 1,
    healthSignals: { ...signals(1), checked_at: "2026-11-16T10:00:00.000Z" },
  });
  const gemini = mockGemini({ [S.no3]: answer(false), [S.no5]: answer(false), [S.junk]: answer(false), [S.bad]: "bad" });
  const { ctx, clock } = context(db, { gemini, missing: new Set([missingKey]) });
  const r = await drive(ctx, clock);
  assert.equal(r.status, "complete");

  // Outcomes on the site.
  assert.equal((await grade(db, S.yes)).is_portfolio, true);
  assert.equal(await hidden(db, S.no3), true, "no, 3 signals: removed");
  assert.equal(await hidden(db, S.junk), true, "junk: removed despite 6 signals");
  assert.equal(await hidden(db, S.no5), false, "no, 5 signals: kept for the owner");
  assert.equal((await grade(db, S.recaptured)).rubric_version, 3, "a newer capture clears the missing-screenshot marker: a real v3 grade");
  assert.equal((await grade(db, S.waiting)).error, "no_usable_captures", "still waiting for a newer capture");
  assert.equal((await grade(db, S.missing)).error, "no_usable_captures");
  assert.equal(await grade(db, S.bad), null);

  // The owner's queue.
  const q = await listReviews(db);
  assert.deepEqual(q.autoApplied.map((x) => x.url).sort(), [S.junk, S.no3].sort());
  const pending = Object.fromEntries(q.pending.map((x) => [x.url, x]));
  assert.deepEqual(Object.keys(pending).sort(), [S.collapsed, S.no5, S.walled].sort());
  assert.equal(pending[S.no5].group, "door_strong_signals");
  assert.equal(pending[S.walled].group, "bot_wall");
  assert.equal(pending[S.walled].proposed, "review");
  assert.equal(pending[S.collapsed].group, "signals_collapsed");
  assert.equal(pending[S.collapsed].proposed, "remove");
  assert.match(pending[S.collapsed].reason, /signals collapsed/);
  // Nothing is written twice: tomorrow's free part finds the open cases.
  const again = await planNight(ctx, { ...r.state, estimate: null, sites: undefined });
  assert.equal(again.sites, undefined, "no new rows the next time");

  // The summary: bounded lists any code can read, and the Markdown.
  const s = r.summary.sites;
  assert.deepEqual(s.graded.map((x) => x.url).sort(), [S.junk, S.no3, S.no5, S.recaptured, S.yes].sort());
  assert.match(s.graded.find((x) => x.url === S.no3).verdict, /removed automatically/);
  assert.deepEqual(s.removed.map((x) => x.url).sort(), [S.junk, S.no3].sort());
  assert.deepEqual(s.review.map((x) => x.url).sort(), [S.collapsed, S.no5, S.walled].sort());
  assert.deepEqual(s.failed.map((x) => x.url), [S.bad]);
  assert.deepEqual(s.setAside.map((x) => x.url), [S.missing]);
  assert.deepEqual(s.counts, { graded: 5, removed: 2, review: 3, failed: 1, setAside: 1 });
  assert.deepEqual(r.summary.missingImage, { waiting: 1, retried: 1 });
  for (const h of ["Sites graded \\(5\\)", "Removed automatically", "Sent to review \\(3\\)", "Failed \\(1\\)", "Set aside \\(1\\)"]) assert.match(r.markdown, new RegExp(h));
  assert.match(r.markdown, /1 waiting for a newer capture, 1 captured again/);
  const stored = JSON.parse(String((await db.execute("SELECT summary FROM night_runs")).rows[0].summary));
  assert.deepEqual(stored.sites.counts, s.counts, "night_runs.summary carries the lists");

  // Every grading request names its site.
  const logged = (await db.execute("SELECT job, item FROM gemini_requests WHERE job = 'grade-new'")).rows;
  assert.ok(logged.length >= 6);
  assert.ok(logged.every((x) => x.item && String(x.item).startsWith("https://")), JSON.stringify(logged));
  assert.ok(logged.some((x) => String(x.item) === S.bad));
});

test("a removal stays off the list through the next weekly health checks (never 'suspect' and shown again)", async () => {
  const db = await freshDb();
  const url = "https://gone.dev";
  await site(db, url, { n: 2 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }) });
  await drive(ctx, clock);
  assert.equal(await hidden(db, url), true);
  const fetchImpl = async (u) => ({ status: 200, ok: true, url: u, text: async () => PORTFOLIO_HTML });
  await runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }], fetchImpl, log: () => {}, now: new Date(T0 + 4 * DAY) });
  assert.equal(String(await col(db, url, "health")), "down");
  // A plain public reason (it reaches data/excluded.json and the Removed page); who decided is kept apart.
  assert.equal(String(await col(db, url, "health_reason")), "AI grading says this is not a portfolio");
  assert.equal(await hidden(db, url), true);
});

test("with REVIEW_AUTO_APPLY off, a Gemini 'no' waits for the owner and the site stays listed; the hourly rule applies it once the switch is on", async () => {
  const db = await freshDb();
  const url = "https://switch-off.dev";
  await site(db, url, { n: 2 });
  const { ctx, clock } = context(db, { gemini: mockGemini({ [url]: answer(false) }), autoApply: false });
  const r = await drive(ctx, clock);
  assert.equal(String((await reviewsOf(db, url))[0].status), "pending");
  assert.equal(await hidden(db, url), false);
  assert.deepEqual(r.summary.sites.review.map((x) => x.url), [url]);
  const applied = await autoApplyReviews(db, { onFeed: () => true, now: new Date(clock.t + 3600000) });
  assert.deepEqual(applied.map((x) => [x.url, x.ok]), [[url, true]]);
  assert.equal(String((await reviewsOf(db, url))[0].decided_by), DOOR_RULE_ACTOR);
  assert.equal(await hidden(db, url), true);
});
