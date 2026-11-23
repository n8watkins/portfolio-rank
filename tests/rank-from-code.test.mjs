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
import { checkSources, dailyRun, geminiYes, libraryMember, pointsOf, rankForWrite, rankFromCode, refreshTiers, seedNewcomers } from "../lib/tiers-store.mjs";
import { readSiteRow, readTierMeta, standingOf, topRows } from "../lib/tiers-db.mjs";
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

  // An error answer changes nothing in the order.
  await addMeasured(client, "https://error.example/", 5);
  await rankFromCode(client, "https://error.example/", { now: NOW });
  await rankForWrite(client, { error: "no_usable_captures" }, { url: "https://error.example/", now: NOW });
  assert.equal((await readSiteRow(client, "https://error.example/")).member, 1);
});

test("the membership trigger keeps a code-ranked site in the library through health changes, and out while delisted or down", async () => {
  const client = await db();
  await library(client);
  await addMeasured(client, "https://trig.example/", 5);
  await rankFromCode(client, "https://trig.example/", { now: NOW });
  const member = async () => (await readSiteRow(client, "https://trig.example/")).member;
  await client.execute("UPDATE portfolios SET health = 'suspect' WHERE url = 'https://trig.example/'");
  assert.equal(await member(), 1, "a failing (suspect) site stays, as graded ones do");
  await client.execute("UPDATE portfolios SET health = 'down' WHERE url = 'https://trig.example/'");
  assert.equal(await member(), 0, "hidden: out");
  await client.execute("UPDATE portfolios SET health = 'live' WHERE url = 'https://trig.example/'");
  assert.equal(await member(), 1, "back");
  await client.execute("UPDATE portfolios SET delisted_at = '2026-11-22' WHERE url = 'https://trig.example/'");
  assert.equal(await member(), 0, "off the list: out");
  await client.execute("UPDATE portfolios SET delisted_at = NULL WHERE url = 'https://trig.example/'");
  assert.equal(await member(), 1);
  // The old trigger (it needed a Gemini letter) is gone.
  const triggers = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tier_member_sync%'")).rows.map((r) => String(r.name));
  assert.deepEqual(triggers, ["tier_member_sync2"]);
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
