// The Starting rank from code (owner, 2026-11-22: "the starting rank you get
// is based off of clear verifiable code measurements"; "a site should have a
// tier"): library membership without a Gemini grade (lib/tiers-store.mjs
// libraryMember), the capture-time and daily paths (rankFromCode, dailyRun),
// the full rebuild, the Removal rule taking a site out of the order, the
// membership trigger, the code-only seed order, the Code checks score read
// the same way for graded and ungraded sites, the prewarm covering every
// member, and no reader of Gemini's letter. On a throwaway database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ensureRosterSchema, ACTIVE } from "../pipeline/roster.mjs";
import { STRONG_SIGNALS } from "../pipeline/portfolio-guard.mjs";
import { NEWCOMERS_PER_RUN, checkSources, dailyRun, geminiYes, goodCapture, libraryMember, pointsOf, rankForWrite, rankFromCode, refreshTiers, seedNewcomers } from "../lib/tiers-store.mjs";
import { shownPoints } from "../lib/check-points.mjs";
import { ensureTierSchema, readSiteRow, readTierMeta, standingOf, topRows } from "../lib/tiers-db.mjs";
import { compareSeed, isTier } from "../lib/tiers.mjs";
import { checksReading } from "../lib/fresh-facts.mjs";
import { prewarmQueue } from "../scripts/lib/prewarm.mjs";
import { siteStats } from "../lib/games/stats.mjs";
import { heroCandidates } from "../pipeline/polls.mjs";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const CAPTURED = "2026-11-21 10:00:00";

async function db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rank-from-code-"));
  const client = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(client);
  await ensureRosterSchema(client);
  return client;
}

/** A rubric v2 Gemini grade with every axis at `axis`. */
const grade = (axis, letter = "B", extra = {}) => ({
  is_portfolio: true,
  tier: letter,
  model: "gemini-test",
  rubric_version: 2,
  visual_design: { score: axis, note: "" },
  five_second_test: { score: axis, note: "" },
  storytelling: { score: axis, note: "" },
  writing: { score: axis, note: "" },
  memorability: { score: axis, note: "" },
  quality_score: axis,
  checks_score: 50,
  judged_at: "2026-11-10T00:00:00Z",
  ...extra,
});

/** Measured facts with `n` of the six portfolio signals. */
const facts = (n, extra = {}) => {
  const names = ["name", "projects", "about", "contact", "resume", "github"];
  const signals = Object.fromEntries(names.map((k, i) => [k, i < n]));
  return { v: 2, resume: true, github: true, contact: true, own_domain: true, footer_year: 2026, project_links: { checked: 3, ok: 3, broken: 0, blocked: 0 }, signals: { ...signals, score: n }, measured_at: "2026-11-21T10:00:00Z", ...extra };
};

const site = (i) => `https://graded${i}.example/`;

/** A library of 60 Gemini-graded members, rebuilt once. */
async function library(client) {
  await client.batch(
    Array.from({ length: 60 }, (_, i) => ({
      sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, ai_rubric, facts) VALUES (?, 'live', 'k', ?, ?, ?)",
      args: [site(i), CAPTURED, JSON.stringify(grade(1 + (i % 5))), JSON.stringify(facts(5, { resume: i % 2 === 0, github: i % 3 === 0 }))],
    })),
    "write"
  );
  await refreshTiers(client, { now: NOW - 86_400_000 });
}

/** A measured site Gemini never graded. */
const addMeasured = (client, url, n, extra = {}) =>
  client.execute({
    sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts, ai_rubric, delisted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [url, extra.status ?? "live", extra.shot === false ? null : "k", CAPTURED, JSON.stringify(facts(n)), extra.rubric ? JSON.stringify(extra.rubric) : null, extra.delisted ?? null],
  });

test("library membership needs no Gemini grade: 4 of 6 signals, a good capture and measured facts", () => {
  assert.equal(STRONG_SIGNALS, 4);
  const base = { listed: true, goodCapture: true, measured: true };
  assert.equal(libraryMember({ ...base, signals: 4 }), "signals");
  assert.equal(libraryMember({ ...base, signals: 6 }), "signals");
  assert.equal(libraryMember({ ...base, signals: 3 }), null, "3 signals and no grade: not ranked yet");
  // The two ways a 3-signal site is ranked later: Gemini's yes, or the owner keeping it.
  assert.equal(libraryMember({ ...base, signals: 3, grade: grade(3) }), "gemini");
  assert.equal(libraryMember({ ...base, signals: 3, ownerKeeps: true }), "owner");
  // Never a member: graded "not a portfolio" (Gemini as the Removal rule acted on it, or the owner), off the list or hidden.
  assert.equal(libraryMember({ ...base, signals: 6, grade: grade(5, "S", { is_portfolio: false }) }), null);
  assert.equal(libraryMember({ ...base, signals: 6, grade: { is_portfolio: false, source: "owner_review" } }), null);
  assert.equal(libraryMember({ ...base, listed: false, signals: 6 }), null);
  // Not measured, or no good capture: not yet.
  assert.equal(libraryMember({ listed: true, goodCapture: false, measured: true, signals: 6 }), null);
  assert.equal(libraryMember({ listed: true, goodCapture: true, measured: false, signals: 6 }), null);
  // An error answer is not a grade: the code checks decide.
  assert.equal(libraryMember({ ...base, signals: 5, grade: { error: "no_usable_captures" } }), "signals");
  // Gemini's yes stays enough, as before (every member before this rule).
  assert.equal(libraryMember({ listed: true, grade: grade(2) }), "gemini");
  assert.equal(geminiYes(grade(2)), true);
});

test("the seed tie-break is code only: points, the date first measured, the address; Gemini's score never counts", () => {
  const e = (url, points, first, key) => ({ url, points, first, key });
  const sorted = [e("b", 70, 5, 100), e("a", 70, 5, 0), e("c", 70, 1, 0), e("d", 71, 9, 0)].sort(compareSeed).map((x) => x.url);
  assert.deepEqual(sorted, ["d", "c", "a", "b"]);
});

test("one Code checks score for one site: an ungraded site's points read its measured facts the same way as a graded one's", () => {
  const f = facts(5);
  const now = new Date(NOW);
  const graded = pointsOf(grade(3, "B", { facts: f }), { facts: f }, null, now);
  const ungraded = pointsOf(null, { facts: f }, null, now);
  assert.equal(ungraded.total, graded.total);
  assert.deepEqual(ungraded.items.map((i) => [i.id, i.points, i.measured]), graded.items.map((i) => [i.id, i.points, i.measured]));
  // The code items come from the facts, measured.
  for (const id of ["resume", "github", "contact", "projects", "footer"]) assert.equal(ungraded.items.find((i) => i.id === id).measured, true, id);
  assert.equal(checksReading(null, null), null);
});

test("a measured site with no Gemini grade gets a Starting rank and a Tier at capture time; one with 3 signals does not", async () => {
  const client = await db();
  await library(client);
  const before = new Map((await topRows(client, 500)).map((r) => [r.url, r]));

  await addMeasured(client, "https://code-only.example/", 5);
  assert.equal(await rankFromCode(client, "https://code-only.example/", { now: NOW }), true);
  const row = await readSiteRow(client, "https://code-only.example/");
  assert.equal(row.member, 1);
  assert.equal(row.seeded, 1);
  assert.ok(typeof row.points === "number" && row.points > 0);
  assert.ok(isTier(row.tier), `a Tier from the first measure, got ${row.tier}`);
  const meta = await readTierMeta(client);
  const s = standingOf(row, meta);
  assert.ok(isTier(s.tier));
  assert.equal(s.provisional, false, "ranked from its starting place");
  // Its stored points are its Code checks score now, the same number the profile shows.
  const sources = (await checkSources(client, { only: "https://code-only.example/" })).get("https://code-only.example/");
  assert.equal(pointsOf(null, sources, meta.medians, new Date(NOW)).total, row.points);
  // Nothing about it lives in a Gemini grade.
  const stored = (await client.execute("SELECT ai_rubric FROM portfolios WHERE url = 'https://code-only.example/'")).rows[0];
  assert.equal(stored.ai_rubric, null);
  // Nobody else moved.
  for (const [url, r] of before) {
    const now = await readSiteRow(client, url);
    assert.equal(now.mu, r.mu, url);
    assert.equal(now.sigma, r.sigma, url);
    assert.equal(now.votes, r.votes, url);
  }
  // Again: already ranked, nothing to do.
  assert.equal(await rankFromCode(client, "https://code-only.example/", { now: NOW }), false);

  // 3 of 6 signals and no grade: not ranked yet.
  await addMeasured(client, "https://three.example/", 3);
  assert.equal(await rankFromCode(client, "https://three.example/", { now: NOW }), false);
  assert.equal((await readSiteRow(client, "https://three.example/")).fresh, true);
  // Off the list, a dead capture, no screenshot: not ranked.
  await addMeasured(client, "https://delisted.example/", 6, { delisted: "2026-11-20" });
  await addMeasured(client, "https://dead.example/", 6, { status: "dead" });
  await addMeasured(client, "https://noshot.example/", 6, { shot: false });
  for (const u of ["https://delisted.example/", "https://dead.example/", "https://noshot.example/"]) assert.equal(await rankFromCode(client, u, { now: NOW }), false, u);
  // Graded "not a portfolio" before it was ever measured: never ranked.
  await addMeasured(client, "https://notone.example/", 6, { rubric: grade(5, "S", { is_portfolio: false }) });
  assert.equal(await rankFromCode(client, "https://notone.example/", { now: NOW }), false);

  // Later Gemini answers "yes" for the 3-signal site: Gemini's yes ranks it.
  const yes = await rankForWrite(client, grade(4), { url: "https://three.example/", now: NOW });
  assert.equal(yes.rank.seeded, true);
  assert.equal((await readSiteRow(client, "https://three.example/")).member, 1);
});

test("Gemini's later grade never moves a code-ranked site; its later 'no' takes it out of the order", async () => {
  const client = await db();
  await library(client);
  await addMeasured(client, "https://later-yes.example/", 5);
  await addMeasured(client, "https://later-no.example/", 6);
  await rankFromCode(client, "https://later-yes.example/", { now: NOW });
  await rankFromCode(client, "https://later-no.example/", { now: NOW });
  const start = await readSiteRow(client, "https://later-yes.example/");

  // Yes: the rank stays exactly where the code checks put it.
  const yes = await rankForWrite(client, grade(1, "D"), { url: "https://later-yes.example/", now: NOW + 1000 });
  const after = await readSiteRow(client, "https://later-yes.example/");
  assert.equal(after.mu, start.mu);
  assert.equal(after.points, start.points);
  assert.equal(after.member, 1);
  assert.ok(yes.rank && yes.rank.seeded);

  // No: out of the order at once, then the stored "not a portfolio" grade keeps it out (the trigger).
  const no = await rankForWrite(client, grade(5, "S", { is_portfolio: false }), { url: "https://later-no.example/", now: NOW + 1000 });
  assert.equal(no.rank, undefined);
  assert.equal((await readSiteRow(client, "https://later-no.example/")).member, 0);
  await client.execute({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?", args: [JSON.stringify(no), "https://later-no.example/"] });
  assert.equal((await readSiteRow(client, "https://later-no.example/")).member, 0);
  await dailyRun(client, { now: NOW + 2000 });
  assert.ok(!(await topRows(client, 500)).some((r) => r.url === "https://later-no.example/"), "not in the order");
  assert.equal((await seedNewcomers(client, { now: NOW + 3000 })).length, 0, "and never seeded again");
  // A full rebuild agrees.
  await refreshTiers(client, { now: NOW + 4000 });
  assert.equal((await readSiteRow(client, "https://later-no.example/")).member, 0);
  assert.equal((await readSiteRow(client, "https://later-yes.example/")).member, 1);

  // An error answer changes nothing for a site the code checks alone make a member: not out for a day.
  await addMeasured(client, "https://error.example/", 5);
  await rankFromCode(client, "https://error.example/", { now: NOW });
  const was = await readSiteRow(client, "https://error.example/");
  const err = await rankForWrite(client, { error: "no_usable_captures" }, { url: "https://error.example/", now: NOW });
  assert.equal(err.rank, undefined);
  await client.execute({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?", args: [JSON.stringify(err), "https://error.example/"] });
  const still = await readSiteRow(client, "https://error.example/");
  assert.equal(still.member, 1);
  assert.equal(still.mu, was.mu);
  // A Gemini member with 3 signals: an error answer takes it out (the code checks alone do not make it one).
  await addMeasured(client, "https://error3.example/", 3, { rubric: grade(3) });
  await rankFromCode(client, "https://error3.example/", { now: NOW });
  assert.equal((await readSiteRow(client, "https://error3.example/")).member, 1);
  await rankForWrite(client, { error: "no_usable_captures" }, { url: "https://error3.example/", now: NOW });
  assert.equal((await readSiteRow(client, "https://error3.example/")).member, 0);
});

test("an owner's removal under another spelling of the address keeps the site out, at capture, daily, in the rebuild and on a Gemini yes", async () => {
  const client = await db();
  await library(client);
  const u = "https://www.spelled.example/";
  await addMeasured(client, u, 6);
  // The owner removed "spelled.example" (no scheme, no www): the same site (lib/ownership/same-site.mjs ownerSiteKey).
  await client.execute("INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES ('spelled.example', '2026-11-22T00:00:00Z', '2026-11-22T00:00:00Z')");
  assert.equal(await rankFromCode(client, u, { now: NOW }), false);
  assert.equal((await seedNewcomers(client, { now: NOW })).length, 0);
  await refreshTiers(client, { now: NOW });
  assert.equal((await readSiteRow(client, u)).member, 0);
  // Gemini says "a portfolio": its row is kept for the day it is accepted, but it is not a member.
  const yes = await rankForWrite(client, grade(4), { url: u, now: NOW });
  assert.equal((await readSiteRow(client, u)).member, 0);
  assert.equal(yes.rank.tier, null, "no Tier while removed");
  // A delisted site: the same.
  await addMeasured(client, "https://gone.example/", 6, { delisted: "2026-11-20" });
  await rankForWrite(client, grade(4), { url: "https://gone.example/", now: NOW });
  assert.equal((await readSiteRow(client, "https://gone.example/")).member, 0);
});

test("rows the membership rule turns down never take the newcomers' places in the daily limit", async () => {
  const client = await db();
  await library(client);
  // Three stored captures from before the capture checked its screen, of a bot check: they pass the query (5 signals,
  // live) but not the rule (no good capture), and sort before the real newcomer.
  const wall = "Just a moment... Verifying you are human. This may take a few seconds.";
  for (let i = 0; i < 3; i++) {
    await client.execute({
      sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts, page_text) VALUES (?, 'live', 'k', '2026-11-01 00:00:00', ?, ?)",
      args: [`https://aaa-wall${i}.example/`, JSON.stringify(facts(5, { resume: false, github: false, contact: false, internal_pages: 0, project_links: { checked: 0, ok: 0, broken: 0, blocked: 0 } })), wall],
    });
  }
  const walls = (await client.execute("SELECT url, status, shot_key, captured_at, facts, page_text, meta AS gate_meta FROM portfolios WHERE url LIKE 'https://aaa-wall%'")).rows;
  for (const r of walls) assert.equal(goodCapture(r), false, "the setup is a blocked capture");
  await addMeasured(client, "https://zzz-real.example/", 5);
  const ranked = await seedNewcomers(client, { now: NOW, limit: 2 });
  assert.deepEqual(ranked, ["https://zzz-real.example/"]);
});

test("the Code checks score shows in whole points that add up to the total shown", () => {
  const check = {
    total: 61.6,
    items: [
      { id: "a", points: 9 },
      { id: "b", points: 5 },
      { id: "c", points: 8.2 },
      { id: "d", points: 9.4 },
      { id: "e", points: 5 },
      { id: "f", points: 10 },
      { id: "g", points: 5 },
      { id: "h", points: 5 },
      { id: "i", points: 5 },
    ],
  };
  const shown = shownPoints(check);
  assert.equal(shown.total, 62);
  assert.equal(Object.values(shown.items).reduce((a, b) => a + b, 0), 62);
  // The missing point goes to the largest remainder (9.4 -> 10), the other stays down (8.2 -> 8).
  assert.equal(shown.items.d, 10);
  assert.equal(shown.items.c, 8);
  // Many breakdowns: the items always add up to the rounded total, and no item moves by a whole point or more.
  for (let seed = 1; seed <= 200; seed++) {
    let x = seed;
    const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
    const items = Array.from({ length: 13 }, (_, k) => ({ id: `i${k}`, points: Math.round(rnd() * 150) / 10 }));
    const total = Math.round(items.reduce((a, i) => a + i.points, 0) * 10) / 10;
    const s = shownPoints({ total, items });
    assert.equal(s.total, Math.round(total));
    assert.equal(Object.values(s.items).reduce((a, b) => a + b, 0), s.total);
    for (const i of items) assert.ok(Math.abs(s.items[i.id] - i.points) < 1, `${i.points} -> ${s.items[i.id]}`);
  }
});

/** A health check's write, as pipeline/health.mjs makes for every listed site every night. */
const healthWrite = (client, url, health = "live") =>
  client.execute({ sql: "UPDATE portfolios SET health = ?, health_checked_at = datetime('now') WHERE url = ?", args: [health, url] });

test("the membership trigger only takes sites out; the daily run brings back, by the membership rule, with the rating kept", async () => {
  const client = await db();
  await library(client);
  const u = "https://trig.example/";
  await addMeasured(client, u, 5);
  await rankFromCode(client, u, { now: NOW });
  // Votes on it, so a return can be seen to keep them.
  await client.execute({ sql: "UPDATE tier_ratings SET votes = 4, faceoffs = 4, mu = mu + 1.5 WHERE url = ?", args: [u] });
  const start = await readSiteRow(client, u);
  const member = async () => (await readSiteRow(client, u)).member;
  await healthWrite(client, u, "suspect");
  assert.equal(await member(), 1, "a failing (suspect) site stays, as graded ones do");
  await healthWrite(client, u, "down");
  assert.equal(await member(), 0, "hidden: out at once");
  await healthWrite(client, u, "live");
  assert.equal(await member(), 0, "working again: the trigger never puts it back by itself");
  assert.equal((await dailyRun(client, { now: NOW + 86_400_000 })).joined, 1);
  const back = await readSiteRow(client, u);
  assert.equal(back.member, 1, "the next daily run puts it back");
  for (const k of ["mu", "sigma", "votes", "faceoffs", "points", "first"]) assert.equal(back[k], start[k], k);
  await client.execute({ sql: "UPDATE portfolios SET delisted_at = '2026-11-22' WHERE url = ?", args: [u] });
  assert.equal(await member(), 0, "off the list: out");
  await client.execute({ sql: "UPDATE portfolios SET delisted_at = NULL WHERE url = ?", args: [u] });
  assert.equal(await member(), 0);
  await dailyRun(client, { now: NOW + 2 * 86_400_000 });
  assert.equal(await member(), 1);
  const triggers = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tier_member%' ORDER BY name")).rows.map((r) => String(r.name));
  assert.deepEqual(triggers, ["tier_member_gone", "tier_member_out"]);
});

test("an owner's Undo that waits for a fresh grade keeps the site out through the nightly health writes and daily runs", async () => {
  const client = await db();
  await library(client);
  const u = "https://undo.example/";
  await addMeasured(client, u, 6);
  await rankFromCode(client, u, { now: NOW });
  // lib/reviews/store.mjs undoReviews: the grade becomes the fresh-grade marker, and the site leaves the tiers.
  const marker = await rankForWrite(client, { error: "fresh_grade_due", judged_at: "2026-11-23T00:00:00Z", reason: "undo" }, { url: u, now: NOW });
  await client.execute({ sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?", args: [JSON.stringify(marker), u] });
  assert.equal((await readSiteRow(client, u)).member, 0);
  for (let day = 1; day <= 2; day++) {
    await healthWrite(client, u);
    await dailyRun(client, { now: NOW + day * 86_400_000 });
    assert.equal((await readSiteRow(client, u)).member, 0, `still out on day ${day}`);
  }
  await refreshTiers(client, { now: NOW + 3 * 86_400_000 });
  assert.equal((await readSiteRow(client, u)).member, 0, "a full rebuild agrees");
  // Its fresh grade says "a portfolio": back, with the rating it had.
  const before = await readSiteRow(client, u);
  await rankForWrite(client, grade(4), { url: u, now: NOW + 4 * 86_400_000 });
  const after = await readSiteRow(client, u);
  assert.equal(after.member, 1);
  assert.equal(after.mu, before.mu);
});

test("a ranked site whose grade is cleared stays out through a health write when the code checks do not make it a member", async () => {
  const client = await db();
  await library(client);
  // A Gemini member with 3 signals: out when its grade is cleared (lib/reviews/store.mjs putGrade, clearGradeStatements).
  const u = "https://cleared.example/";
  await addMeasured(client, u, 3, { rubric: grade(3) });
  await rankFromCode(client, u, { now: NOW });
  assert.equal((await readSiteRow(client, u)).member, 1);
  await client.execute({ sql: "UPDATE portfolios SET ai_rubric = NULL WHERE url = ?", args: [u] });
  await client.execute({ sql: "UPDATE tier_ratings SET member = 0, dirty = 1 WHERE url = ?", args: [u] });
  await healthWrite(client, u);
  assert.equal((await readSiteRow(client, u)).member, 0, "the health check's write never puts it back");
  await dailyRun(client, { now: NOW + 86_400_000 });
  assert.equal((await readSiteRow(client, u)).member, 0, "3 signals and no grade: not a member");
  await refreshTiers(client, { now: NOW + 2 * 86_400_000 });
  assert.equal((await readSiteRow(client, u)).member, 0, "a full rebuild agrees");
});

test("on a database that has the old membership triggers, the schema step replaces them with the one that only takes out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rank-from-code-old-"));
  const file = `file:${path.join(dir, "db.sqlite")}`;
  const first = createClient({ url: file });
  await migrate(first);
  await ensureRosterSchema(first);
  await ensureTierSchema(first);
  // The two earlier triggers, as they were created on main and on the first version of this change.
  await first.execute("DROP TRIGGER IF EXISTS tier_member_out");
  await first.execute(`CREATE TRIGGER tier_member_sync AFTER UPDATE OF delisted_at, health, ai_rubric ON portfolios BEGIN
    UPDATE tier_ratings SET member = (CASE WHEN NEW.delisted_at IS NULL AND COALESCE(NEW.health, '') != 'down' AND json_valid(NEW.ai_rubric)
      AND json_extract(NEW.ai_rubric, '$.tier') IS NOT NULL THEN 1 ELSE 0 END), dirty = 1 WHERE url = NEW.url AND seeded = 1; END`);
  await first.execute(`CREATE TRIGGER tier_member_sync2 AFTER UPDATE OF health ON portfolios BEGIN
    UPDATE tier_ratings SET member = 1 WHERE url = NEW.url AND seeded = 1; END`);
  first.close();
  // A new client (a new Worker isolate or job) runs the schema step once.
  const client = createClient({ url: file });
  await ensureTierSchema(client);
  const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tier_member%' ORDER BY name")).rows.map((r) => String(r.name));
  assert.deepEqual(names, ["tier_member_gone", "tier_member_out"]);
  // A code-ranked site keeps its place through a health write.
  await client.execute("INSERT INTO portfolios (url, status, facts) VALUES ('https://x.example/', 'live', '{}')");
  await client.execute("INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, member, seeded) VALUES ('https://x.example/', 25, 8, 9, 36, 1, 1)");
  await healthWrite(client, "https://x.example/");
  assert.equal((await readSiteRow(client, "https://x.example/")).member, 1);
});

test("the daily run takes at most NEWCOMERS_PER_RUN, the rest the next day; an owner's removal is never ranked", async () => {
  assert.equal(NEWCOMERS_PER_RUN, 300);
  const client = await db();
  await library(client);
  for (let i = 0; i < 5; i++) await addMeasured(client, `https://cap${i}.example/`, 5);
  assert.equal((await seedNewcomers(client, { now: NOW, limit: 2 })).length, 2);
  assert.equal((await seedNewcomers(client, { now: NOW, limit: 2 })).length, 2);
  assert.equal((await seedNewcomers(client, { now: NOW, limit: 2 })).length, 1);
  assert.equal((await seedNewcomers(client, { now: NOW, limit: 2 })).length, 0);
  // Removed by its verified owner, still on the list until the nightly export: not ranked, at capture or daily.
  await addMeasured(client, "https://removed.example/", 6);
  await client.execute("INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES ('https://removed.example/', '2026-11-22T00:00:00Z', '2026-11-22T00:00:00Z')");
  assert.equal(await rankFromCode(client, "https://removed.example/", { now: NOW }), false);
  assert.equal((await seedNewcomers(client, { now: NOW })).length, 0);
  await refreshTiers(client, { now: NOW });
  assert.equal((await readSiteRow(client, "https://removed.example/")).member, 0);
});

test("the daily run ranks every measured newcomer among the others without moving anyone's rating or votes, and writes its Tier", async () => {
  const client = await db();
  await library(client);
  // Some votes on existing members.
  await client.batch(
    Array.from({ length: 6 }, (_, i) => ({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES (?, ?, ?, 'human', ?, datetime('2026-11-22', ?))",
      args: [site(i), site(i + 10), `${i}`, `r${i}`, `+${i} seconds`],
    })),
    "write"
  );
  await refreshTiers(client, { now: NOW - 3600_000 });
  const before = new Map((await topRows(client, 500)).map((r) => [r.url, r]));
  const n0 = (await readTierMeta(client)).n;

  // Measured before this rule: no rank (the capture-time step never ran for them).
  for (let i = 0; i < 5; i++) await addMeasured(client, `https://new${i}.example/`, 4 + (i % 3));
  await addMeasured(client, "https://three-signals.example/", 3);
  const r = await dailyRun(client, { now: NOW });
  assert.equal(r.joined, 5);
  for (let i = 0; i < 5; i++) {
    const row = await readSiteRow(client, `https://new${i}.example/`);
    assert.equal(row.member, 1);
    assert.ok(isTier(row.tier), "the daily run wrote its Tier");
  }
  assert.equal((await readSiteRow(client, "https://three-signals.example/")).fresh, true);
  assert.equal((await readTierMeta(client)).n, n0 + 5);
  for (const [url, b] of before) {
    const a = await readSiteRow(client, url);
    assert.equal(a.mu, b.mu, url);
    assert.equal(a.sigma, b.sigma, url);
    assert.equal(a.votes, b.votes, url);
    assert.equal(a.faceoffs, b.faceoffs, url);
  }
  // The next day: nothing new.
  assert.equal((await dailyRun(client, { now: NOW + 86_400_000 })).joined, 0);
});

test("the full rebuild ranks code-only members with graded ones, keeps each site's first date, and never reads Gemini's score", async () => {
  const client = await db();
  await library(client);
  await addMeasured(client, "https://code-a.example/", 5);
  await addMeasured(client, "https://code-b.example/", 6);
  await addMeasured(client, "https://code-c.example/", 2);
  const r = await refreshTiers(client, { now: NOW });
  assert.equal(r.library, 62, "60 graded + 2 measured with 4 or more signals");
  for (const u of ["https://code-a.example/", "https://code-b.example/"]) {
    const row = await readSiteRow(client, u);
    assert.equal(row.member, 1, u);
    assert.equal(row.seeded, 1, u);
    assert.ok(isTier(row.tier), u);
    assert.ok(row.first != null, "the capture date stands in for when it was first measured");
  }
  assert.equal((await readSiteRow(client, "https://code-c.example/")).member, 0);
  // Rebuilt again: the first date is kept, nothing rewritten.
  const first = (await readSiteRow(client, "https://code-a.example/")).first;
  await client.execute("UPDATE portfolios SET captured_at = '2026-11-23 01:00:00' WHERE url = 'https://code-a.example/'");
  const again = await refreshTiers(client, { now: NOW + 1000 });
  assert.equal((await readSiteRow(client, "https://code-a.example/")).first, first);
  assert.equal(again.rows, 0);

  // Two graded sites with equal points: Gemini's very different scores change nothing in the order.
  const flip = await db();
  const same = facts(5);
  await flip.batch(
    [
      ["https://early.example/", grade(1, "D", { judged_at: "2026-11-01T00:00:00Z" })],
      ["https://late.example/", grade(5, "S", { judged_at: "2026-11-02T00:00:00Z" })],
    ].map(([url, g]) => ({ sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, ai_rubric, facts) VALUES (?, 'live', 'k', ?, ?, ?)", args: [url, CAPTURED, JSON.stringify(g), JSON.stringify(same)] })),
    "write"
  );
  await refreshTiers(flip, { now: NOW });
  const early = await readSiteRow(flip, "https://early.example/");
  const late = await readSiteRow(flip, "https://late.example/");
  assert.equal(early.points, late.points);
  assert.ok(early.mu > late.mu, "equal points: the one measured first starts higher, though Gemini scored it 1 of 5");
});

test("the prewarm measures Lighthouse for every member, graded or not, never for 'not a portfolio'", async () => {
  const client = await db();
  await addMeasured(client, "https://code-only.example/", 5);
  await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES ('https://graded.example/', 'live', ?)", args: [JSON.stringify(grade(3))] });
  await client.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric, facts) VALUES ('https://notone.example/', 'live', ?, ?)", args: [JSON.stringify(grade(3, "B", { is_portfolio: false })), JSON.stringify(facts(6))] });
  await client.execute("INSERT INTO portfolios (url, status) VALUES ('https://nothing.example/', 'live')");
  const urls = await prewarmQueue(client, { active: ACTIVE, now: NOW });
  assert.deepEqual(urls.sort(), ["https://code-only.example/", "https://graded.example/"]);
});

test("no reader shows or counts Gemini's letter: stats, polls and the pages read the Tier", async () => {
  const client = await db();
  await library(client);
  await dailyRun(client, { now: NOW });
  // Every Gemini letter S: the average Tier still comes from the tier store.
  await client.execute({ sql: "UPDATE portfolios SET ai_rubric = json_set(ai_rubric, '$.tier', 'S')" });
  const s = await siteStats(client, { feed: [], now: new Date(NOW) });
  assert.ok(s.averageTier && isTier(s.averageTier.tier));
  assert.notEqual(s.averageTier.tier, "S", "an average of the Tiers, not of Gemini's S");
  // Poll screenshots: only sites with an S or A family Tier, whatever Gemini said.
  const picks = new Set((await heroCandidates(client, { known: [], now: NOW })).map((p) => p.url));
  const tiers = (await client.execute("SELECT url, tier FROM tier_ratings WHERE member = 1")).rows;
  for (const t of tiers) assert.equal(picks.has(String(t.url)), ["S", "A"].includes(String(t.tier)[0]), String(t.url));
  assert.ok(picks.size > 0 && picks.size < tiers.length);

  // The pages and readers that used to show Gemini's letter (the audit's D2 table) no longer read it.
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  assert.doesNotMatch(read("lib/leaderboard.ts"), /'\$\.tier'\) AS tier/);
  assert.doesNotMatch(read("lib/home.ts"), /tier: p\.tier|'\$\.tier'\) AS tier/);
  assert.doesNotMatch(read("app/p/[slug]/page.tsx"), /grade\.tier|showTier/);
  assert.doesNotMatch(read("lib/games/stats.mjs"), /TIER_VALUE\[tier\]/);
  assert.doesNotMatch(read("pipeline/polls.mjs"), /ai_rubric, '\$\.tier'\) IN/);
  assert.doesNotMatch(read("pipeline/content/facts.mjs"), /rubric\.tier === "S"/);
  assert.match(read("app/report/print/route.ts"), /showTier: false/);
  assert.doesNotMatch(read("app/grading/page.tsx"), /The AI makes the call/);
});
