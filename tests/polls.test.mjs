// Polls without a server: the weeks, the one-vote rule, the rate limits,
// the results feed, the nightly scheduling by code and the Gemini
// generation (mocked) with its validation and weekly cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { nextWeek, pollWeek } from "../lib/polls/week.mjs";
import { castVote, myVote, percents, pollResults, prunePolls, rateLimit, readPoll, readPolls } from "../lib/polls/store.mjs";
import {
  EVERGREEN,
  HERO_QUESTION,
  WEEKLY_REQUESTS,
  buildPollRequest,
  dataDigest,
  generatePolls,
  generationNeeded,
  insertPoll,
  schedulePolls,
  similarQuestions,
  validateCandidates,
} from "../pipeline/polls.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { createGemini, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import feed from "../data/feed.json" with { type: "json" };

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polls-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  return db;
}

// Tuesday 2026-11-10, 20:30 Pacific (standard time).
const T0 = Date.parse("2026-11-11T04:30:00Z");

test("weeks run Monday to Monday in Los Angeles, across daylight time", () => {
  const w = pollWeek(new Date(T0));
  assert.equal(w.id, "2026-11-09");
  assert.equal(w.opensAt.toISOString(), "2026-11-09T08:00:00.000Z");
  assert.equal(w.closesAt.toISOString(), "2026-11-16T08:00:00.000Z");
  // Sunday 23:59 Pacific is still the same week; Monday 00:00 is the next.
  assert.equal(pollWeek(new Date("2026-11-16T07:59:00Z")).id, "2026-11-09");
  assert.equal(pollWeek(new Date("2026-11-16T08:00:00Z")).id, "2026-11-16");
  // The week daylight time ends in is 169 hours long.
  const dst = pollWeek(new Date("2026-11-03T12:00:00Z"));
  assert.equal(dst.id, "2026-11-02");
  assert.equal(dst.opensAt.toISOString(), "2026-11-02T08:00:00.000Z");
  const before = pollWeek(new Date("2026-10-30T12:00:00Z"));
  assert.equal(before.opensAt.toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal((before.closesAt - before.opensAt) / 3600000, 169);
  assert.equal(nextWeek(w).id, "2026-11-16");
});

test("percentages are whole and add up to 100", () => {
  assert.deepEqual(percents([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(percents([0, 0]), [0, 0]);
  assert.deepEqual(percents([2, 1]), [67, 33]);
});

async function seedPoll(db, { at = T0, kind = "text", options = ["Yes", "No"], question = "Should a portfolio link a resume?" } = {}) {
  const week = pollWeek(new Date(at));
  await insertPoll(db, { week, kind, question, detail: "d", options: options.map((o) => (typeof o === "string" ? { label: o } : o)), source: "code", now: at });
  return week;
}

test("one vote per visitor: per account and per browser; totals only, never who voted", async () => {
  const db = await freshDb();
  const week = await seedPoll(db);
  const now = new Date(T0);
  assert.deepEqual(await castVote(db, { pollId: week.id, option: 0, voter: "anon:a", browser: "anon:a", now }), { ok: true, mine: 0 });
  // Same browser again, even signed in now.
  assert.deepEqual(await castVote(db, { pollId: week.id, option: 1, voter: "gh:1", browser: "anon:a", now }), { ok: false, error: "already_voted", mine: 0 });
  // Signed in on another browser.
  assert.deepEqual(await castVote(db, { pollId: week.id, option: 1, voter: "gh:2", browser: "anon:b", now }), { ok: true, mine: 1 });
  assert.equal((await castVote(db, { pollId: week.id, option: 0, voter: "gh:2", browser: "anon:c", now })).error, "already_voted");
  assert.equal(await myVote(db, { pollId: week.id, voter: "gh:2", browser: "anon:zzz" }), 1);
  assert.equal(await myVote(db, { pollId: week.id, voter: "anon:new", browser: "anon:new" }), null);
  // Bad option, unknown poll, closed poll.
  assert.equal((await castVote(db, { pollId: week.id, option: 5, voter: "anon:d", browser: "anon:d", now })).error, "bad_option");
  assert.equal((await castVote(db, { pollId: "2020-01-06", option: 0, voter: "anon:d", browser: "anon:d", now })).error, "not_found");
  assert.equal((await castVote(db, { pollId: week.id, option: 0, voter: "anon:d", browser: "anon:d", now: week.closesAt })).error, "closed");
  // An upcoming poll can't be voted on or read.
  const next = nextWeek(week);
  await insertPoll(db, { week: next, kind: "text", question: "Dark or light portfolio?", options: [{ label: "Dark" }, { label: "Light" }], source: "code", now: T0 });
  assert.equal((await castVote(db, { pollId: next.id, option: 0, voter: "anon:d", browser: "anon:d", now })).error, "not_found");
  assert.equal(await readPoll(db, next.id, { now }), null);

  const { active, past } = await readPolls(db, { now });
  assert.equal(active.id, week.id);
  assert.equal(active.status, "active");
  assert.equal(active.total, 2);
  assert.deepEqual(active.options.map((o) => [o.label, o.votes, o.percent]), [["Yes", 1, 50], ["No", 1, 50]]);
  assert.deepEqual(past, []);
  // Nothing in a public result names a voter.
  assert.doesNotMatch(JSON.stringify(active), /anon:|gh:/);

  // Concurrent double votes from one browser: exactly one counts.
  const db2 = await freshDb();
  const w2 = await seedPoll(db2);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => castVote(db2, { pollId: w2.id, option: i % 2, voter: "anon:x", browser: "anon:x", now })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await readPoll(db2, w2.id, { now })).total, 1);
});

test("results feed: closed polls with totals, winner and margin; old vote rows are pruned, totals stay", async () => {
  const db = await freshDb();
  const week = await seedPoll(db, { options: ["A", "B", "C"] });
  const now = new Date(T0);
  for (const [i, opt] of [0, 0, 0, 1].entries()) await castVote(db, { pollId: week.id, option: opt, voter: `anon:${i}`, browser: `anon:${i}`, now });
  assert.deepEqual(await pollResults(db, { now }), [], "an active poll is not a result yet");
  const later = new Date(week.closesAt.getTime() + 3600000);
  const [r] = await pollResults(db, { now: later });
  assert.equal(r.status, "closed");
  assert.equal(r.total, 4);
  assert.equal(r.winner, 0);
  assert.equal(r.margin, 50);
  assert.equal((await readPolls(db, { now: later })).past[0].id, week.id);

  assert.deepEqual(await prunePolls(db, { now: later }), { votes: 0, rateLimits: 0 });
  const muchLater = new Date(week.closesAt.getTime() + 31 * 86400000);
  assert.equal((await prunePolls(db, { now: muchLater })).votes, 4);
  assert.equal((await readPoll(db, week.id, { now: muchLater })).total, 4, "totals survive the pruning");
});

test("rate limits: a fixed window per key, in the database", async () => {
  const db = await freshDb();
  const opts = { limit: 3, windowMs: 60000 };
  const hits = [];
  for (let i = 0; i < 4; i++) hits.push(await rateLimit(db, "k", { ...opts, now: 1000 + i }));
  assert.deepEqual(hits.map((h) => h.ok), [true, true, true, false]);
  assert.ok(hits[3].retryAfterSec >= 59);
  assert.equal((await rateLimit(db, "other", { ...opts, now: 1005 })).ok, true, "keys are separate");
  assert.equal((await rateLimit(db, "k", { ...opts, now: 1000 + 60000 })).n, 1, "a new window starts over");
});

// ---------------------------------------------------------------------------
// The end-of-day part
// ---------------------------------------------------------------------------

const urls = feed.map((p) => p.url);
const facts = (over = {}) => JSON.stringify({ contact: true, own_domain: true, motion: false, signals: { resume: true, github: true, about: true }, ...over });

async function nightDb({ top = 4, low = 3 } = {}) {
  const db = await freshDb();
  let i = 0;
  for (const [n, tier] of [[top, "A"], [low, "D"]]) {
    for (let k = 0; k < n; k++, i++) {
      await db.execute({
        sql: `INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, facts) VALUES (?, ?, 'live', ?, '2026-11-01 00:00:00', ?, ?)`,
        args: [urls[i], feed[i].name, `k${i}`, JSON.stringify({ tier, is_portfolio: true }), facts({ signals: { resume: k % 2 === 0, github: true, about: true } })],
      });
    }
  }
  return db;
}

function nightCtx(db, { at = T0, image = async () => ({ inline_data: {} }), steps = [] } = {}) {
  const clock = { t: at };
  const calls = [];
  const lines = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(String(init.body)));
    const step = typeof steps === "function" ? steps(calls.length - 1) : steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step.status && step.status !== 200) return new Response(step.text ?? "", { status: step.status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(step.json) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200 } }), { status: 200 });
  };
  const ctx = { db, now: () => clock.t, image, log: (l) => lines.push(l) };
  const gemini = () => createGemini({ apiKey: "test-key-not-real", models: [PRIMARY_MODEL], fetchImpl, sleep: async () => {}, retryDelaysMs: [1], log: () => {} });
  return { ctx, clock, calls, lines, gemini };
}

test("every week gets a poll by code when nothing was written ahead: a hero pair of top sites, never a low scorer", async () => {
  const db = await nightDb();
  const { ctx, clock } = nightCtx(db);
  const first = await schedulePolls(ctx);
  assert.deepEqual(first.made, ["2026-11-09 (hero)"]);
  const poll = await readPoll(db, "2026-11-09", { now: new Date(T0) });
  assert.equal(poll.kind, "hero");
  assert.equal(poll.question, HERO_QUESTION);
  assert.deepEqual(poll.options.map((o) => o.label), ["Left", "Right"]);
  const shown = poll.options.map((o) => o.url);
  assert.ok(shown.every((u) => urls.slice(0, 4).includes(u)), "only A-graded sites");
  // Running again the same night changes nothing.
  assert.deepEqual((await schedulePolls(ctx)).made, []);
  // Sunday night: next week starts before tomorrow's run, so it gets one too
  // (a text poll: two hero polls are not made back to back).
  clock.t = Date.parse("2026-11-16T04:30:00Z");
  const sunday = await schedulePolls(ctx);
  assert.deepEqual(sunday.made, ["2026-11-16 (text)"]);
  const text = await readPoll(db, "2026-11-16", { now: new Date("2026-11-16T09:00:00Z") });
  assert.equal(text.question, EVERGREEN[0].question);
});

test("missing screenshots: the hero poll is skipped for an evergreen one", async () => {
  const db = await nightDb();
  const { ctx } = nightCtx(db, { image: async () => "missing" });
  assert.deepEqual((await schedulePolls(ctx)).made, ["2026-11-09 (text)"]);
});

test("validation by code: kinds, lengths, options, tone, no names or links, no duplicates", () => {
  const good = { kind: "text", topic: "projects", question: "How long should a project write-up be?", detail: "On a portfolio.", options: ["A paragraph", "A page", "A full case study"] };
  const raw = {
    polls: [
      good,
      { ...good, question: "How long should a project write-up be?" }, // same as the first
      { ...good, question: "Which portfolio has the worst design?" },
      { ...good, question: "Is Aaaabad Ahmed's site the best one here?" },
      { ...good, question: "Do you like sawad.framer.website more?" },
      { ...good, question: "Would you hire from www.example.com today?" },
      { ...good, question: "Short?", options: ["Yes", "No"] },
      { ...good, question: "Which skills section style works best?", options: ["Only one"] },
      { ...good, question: "Which skills section style works best?", options: ["Icons", "icons"] },
      { kind: "hero", topic: "hero section", question: "Which first screen makes you want to scroll?", detail: "First screen only.", options: [] },
      { kind: "hero", topic: "hero section", question: "Which hero tells you more in five seconds?", detail: "", options: [] },
      { kind: "quiz", topic: "projects", question: "Is this a quiz kind of question?", detail: "", options: ["a", "b"] },
    ],
  };
  const { accepted, rejected } = validateCandidates(raw, { asked: ["Dark or light portfolio?"], names: ["Aaaabad Ahmed", "sawad.framer.website"] });
  assert.deepEqual(accepted.map((a) => a.kind), ["text", "hero"]);
  assert.deepEqual(
    rejected.map((r) => r.reason),
    [
      "duplicate question",
      "negative wording",
      "names a person or site",
      "names a person or site",
      "a link, handle or address",
      "question must be 10 to 100 characters and end with ?",
      "a text poll needs 2 to 4 options",
      "duplicate options",
      "one hero poll per batch",
      "unknown kind",
    ]
  );
  assert.equal(validateCandidates("not json").rejected[0].reason, "not JSON");
  assert.ok(similarQuestions("Should a portfolio show a resume?", "Should your portfolio show a resume?"));
  assert.ok(!similarQuestions("Should a portfolio show a resume?", "Dark or light portfolio?"));
});

test("the request: aggregate data only, the questions already asked, 3.5 Flash-Lite", async () => {
  const db = await nightDb();
  const digest = await dataDigest(db);
  assert.equal(digest.graded, 7);
  assert.equal(digest.topTierPercent, 57);
  assert.equal(digest.githubLinkPercent, 100);
  const req = buildPollRequest({ digest, asked: ["Dark or light portfolio?"] });
  const text = req.parts[0].text;
  assert.match(text, /Dark or light portfolio\?/);
  for (const p of feed.slice(0, 7)) {
    assert.ok(!text.includes(p.url) && !text.includes(p.name), "no site or name is sent");
  }
  assert.match(req.options.systemInstruction, /Never name or describe a person/);
});

test("nightly generation: one request writes candidates, code checks them, each accepted one gets the next free week", async () => {
  const db = await nightDb();
  const answer = {
    polls: [
      { kind: "hero", topic: "hero section", question: "Which first screen makes you want to scroll?", detail: "Look at the first screen only.", options: [] },
      { kind: "text", topic: "job search", question: "Where do you share your portfolio first?", detail: "When you start a job search.", options: ["LinkedIn", "Applications", "Social media", "Meetups"] },
      { kind: "text", topic: "projects", question: "Which portfolio is the most boring here?", detail: "", options: ["A", "B"] },
      { kind: "text", topic: "tech stack", question: "Should a portfolio list its tech stack?", detail: "Logos, a list, or nothing.", options: ["Yes, with logos", "A plain list", "Not needed"] },
    ],
  };
  const { ctx, clock, calls, gemini } = nightCtx(db, { steps: [{ json: answer }] });
  await schedulePolls(ctx); // this week, by code
  assert.deepEqual(await generationNeeded(ctx), { n: 1, why: "" });
  const g = gemini();
  const out = await generatePolls(ctx, g, { night: "2026-11-10" });
  assert.equal(calls.length, 1);
  assert.deepEqual(out.scheduled, ["2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.deepEqual(out.rejected.map((r) => r.reason), ["negative wording"]);
  const hero = await readPoll(db, "2026-11-16", { now: new Date("2026-11-17T00:00:00Z") });
  assert.equal(hero.kind, "hero");
  assert.equal(hero.options.length, 2);
  const thisWeek = await readPoll(db, "2026-11-09", { now: new Date(T0) });
  const both = [...hero.options, ...thisWeek.options].map((o) => o.url);
  assert.equal(new Set(both).size, 4, "no site shown twice in a row");
  const gen = (await db.execute("SELECT requests, proposed, accepted, status, model FROM poll_generations")).rows[0];
  assert.deepEqual([Number(gen.requests), Number(gen.proposed), Number(gen.accepted), String(gen.status), String(gen.model)], [1, 4, 3, "ok", PRIMARY_MODEL]);
  // Enough weeks scheduled now: nothing more to write.
  assert.match((await generationNeeded(ctx)).why, /weeks already scheduled/);
  // Duplicates of what is scheduled are never accepted later.
  assert.equal(validateCandidates({ polls: [answer.polls[1]] }, { asked: (await db.execute("SELECT question FROM polls")).rows.map((r) => String(r.question)) }).accepted.length, 0);
  void clock;
});

test("the weekly cap: at most 2 requests in any 7 days, one try a night, failures recorded", async () => {
  const db = await nightDb();
  const { ctx, clock, gemini } = nightCtx(db, { steps: [{ json: { polls: [] } }] });
  await schedulePolls(ctx);
  await generatePolls(ctx, gemini(), { night: "2026-11-10" });
  assert.match((await generationNeeded(ctx)).why, /already tried tonight/);
  clock.t += 86400000;
  assert.equal((await generationNeeded(ctx)).n, 1);
  await generatePolls(ctx, gemini(), { night: "2026-11-11" });
  clock.t += 86400000;
  assert.equal(WEEKLY_REQUESTS, 2);
  assert.match((await generationNeeded(ctx)).why, /weekly cap \(2 of 2/);
  clock.t += 6 * 86400000;
  assert.equal((await generationNeeded(ctx)).n, 1, "a week later it may try again");

  // A failed request is recorded (and counts), then rethrown for the stage.
  const db2 = await nightDb();
  const bad = nightCtx(db2, { steps: [{ status: 400, text: "bad request" }] });
  await assert.rejects(generatePolls(bad.ctx, bad.gemini(), { night: "2026-11-10" }));
  const row = (await db2.execute("SELECT status, requests FROM poll_generations")).rows[0];
  assert.deepEqual([String(row.status), Number(row.requests)], ["failed", 1]);
});
