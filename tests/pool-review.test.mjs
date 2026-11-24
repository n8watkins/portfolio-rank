// The independent review of #292 (head c5e3c6b), one test or more per finding:
// protection against mass mistakes and the edge cases of the temporary pool
// and the archive. Offline: throwaway databases, a simulated clock, stand-ins
// for the plain request and the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import * as health from "../pipeline/health.mjs";
import * as pool from "../pipeline/not-working.mjs";
import { runRecheck } from "../pipeline/recheck.mjs";
import { RETURN_VETOES, passesFullCheck, planDeadRecheck, returnVeto } from "../pipeline/exclusions.mjs";
import { ACTIVE } from "../pipeline/roster.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { activeAlerts } from "../pipeline/alerts.mjs";
import { ensureReviewSchema } from "../lib/reviews/store.mjs";
import { migrate } from "../lib/schema.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";
import { healthPool } from "../lib/admin/health-pool.mjs";
import { EMPTY_HTML, PORTFOLIO_HTML, T0, answer, col, freshDb, site } from "./helpers/door-night.mjs";

const quiet = () => {};
const H = 3600000;
const D = 86400000;
const at = (ms) => new Date(ms);
const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });
const goodPage = (url) => ({ status: 200, finalUrl: `${url}/`, title: "Ann Lee | Engineer", text: "Ann Lee builds web apps. Projects, about and contact.", media: false, html: PORTFOLIO_HTML });

function world() {
  const mode = new Map();
  const of = (u) => [...mode].find(([url]) => u.startsWith(url))?.[1] ?? "ok";
  const fetchImpl = async (u) => (of(u) === "paused" ? response(402, "This deployment is temporarily paused", u) : response(200, PORTFOLIO_HTML, u));
  const render = async (u) => (of(u) === "paused" ? { status: 402, finalUrl: `${u}/`, title: "", text: "This deployment is temporarily paused", media: false, html: "" } : goodPage(u));
  return { mode, fetchImpl, render };
}

async function setup(urls, fillerCount = 30) {
  const { db } = await freshDb();
  const fillers = Array.from({ length: fillerCount }, (_, i) => ({ url: `https://filler-${i}.dev`, name: "Ann Lee" }));
  for (const f of fillers) await site(db, f.url, { rubric: answer(true) });
  for (const u of urls) await site(db, u, { rubric: answer(true) });
  const feed = [...urls.map((url) => ({ url, name: "Ann Lee" })), ...fillers];
  const w = world();
  const nightly = (now) => health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  const hourly = (now) => runRecheck({ db, fetchImpl: w.fetchImpl, render: w.render, now: at(now), log: quiet });
  return { db, feed, w, nightly, hourly };
}

const hiddenCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM portfolios WHERE health = 'down'")).rows[0].n);

// ---------------------------------------------------------------------------
// F1 and the second review: the drain (20 hides a day, oldest first) and the spike freeze

const spikeAlert = async (db) => (await activeAlerts(db)).some((a) => a.key === health.SPIKE_ALERT_KEY);

for (const n of [25, 36]) {
  test(`the drain: ${n} really dead sites are all hidden within two days of their confirming day, 20 a day, with no alert`, async () => {
    const many = Array.from({ length: n }, (_, i) => `https://dead-${String(i).padStart(2, "0")}.example`);
    const { db, w, nightly, hourly } = await setup(many, 100);
    await nightly(T0);
    for (const u of many) w.mode.set(u, "paused");
    const F = T0 + D;
    await nightly(F);
    await hourly(F + H);
    const s = await hourly(F + D);
    assert.equal(await hiddenCount(db), pool.HIDE_PER_DAY, "20 on the confirming day");
    assert.equal(s.pace.drained.length, n - pool.HIDE_PER_DAY, "the rest wait their turn");
    for (const d of s.pace.drained) assert.equal(String((await db.execute({ sql: "SELECT pool_held FROM health_marks WHERE url = ?", args: [d.url] })).rows[0].pool_held), "drain");
    assert.equal(await spikeAlert(db), false, "no alert for the ordinary pace");
    await hourly(F + 2 * D);
    assert.equal(await hiddenCount(db), n, "all hidden the next day");
    assert.equal(await spikeAlert(db), false);
    // The oldest first failures went first.
    const order = (await db.execute("SELECT m.url FROM health_marks m WHERE m.pool_stage = 3 ORDER BY m.pool_since, m.pool_first_at")).rows.map((r) => String(r.url));
    assert.equal(order.length, n);
  });
}

test("the drain: two batches in one hour never hide more than the day's 20 between them", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `https://batch-${String(i).padStart(2, "0")}.example`);
  const { db, w, nightly } = await setup(many, 100);
  await nightly(T0);
  for (const u of many) w.mode.set(u, "paused");
  const check = (feed, t) => health.runHealthCheck({ db, feed, fetchImpl: w.fetchImpl, render: w.render, now: at(t), scheduled: "check", alerts: false, doorLimit: 0, log: quiet });
  const feed = many.map((url) => ({ url, name: "Ann Lee" }));
  await check(feed, T0 + D);
  await check(feed, T0 + D + H);
  await check(feed.slice(0, 15), T0 + 2 * D);
  await check(feed.slice(15), T0 + 2 * D + 60000);
  assert.equal(await hiddenCount(db), pool.HIDE_PER_DAY);
});

test("the drain: the day-8 wave of weak verdicts (40 blank pages that started on one day) drains 5 a day, then 1 a day under the leak alert", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://wave-${String(i).padStart(2, "0")}.example`);
  const { db } = await setup(many, 0);
  const blank = async (u) => response(200, "<div id=root></div>", u);
  const blankRender = async (u) => ({ status: 200, finalUrl: u, title: "", text: "", media: false, html: "<div id=root></div>" });
  const feed = many.map((url) => ({ url, name: "Ann Lee" }));
  const check = (t) => health.runHealthCheck({ db, feed, fetchImpl: blank, render: blankRender, now: at(t), scheduled: "check", alerts: false, doorLimit: 0, log: quiet });
  await check(T0);
  await check(T0 + H);
  await check(T0 + D);
  assert.equal(await hiddenCount(db), 0, "a weak verdict waits a week");
  await check(T0 + 7 * D);
  assert.equal(await hiddenCount(db), pool.HIDE_WEAK_PER_DAY);
  assert.equal(await spikeAlert(db), false, "40 blank pages is under the spike limits");
  const byDay = {};
  for (let d = 8; d <= 40; d++) {
    await check(T0 + d * D + H);
    byDay[d] = await hiddenCount(db);
  }
  assert.equal(byDay[9], 15, "5 a day");
  assert.equal(byDay[10], 20, "the leak alert is raised at the end of this run (20 in a week)");
  assert.equal(byDay[11], 21, "then 1 a day while it is up");
  assert.equal(byDay[40], 40, "all hidden in the end");
  assert.equal(await spikeAlert(db), false, "40 of one kind is no freeze");
});

test("the spike freeze: 300 sites failing at once (a host-wide 500) are none hidden and alert; when it ends, those still failing need their full evidence again and drain", async () => {
  const many = Array.from({ length: 300 }, (_, i) => `https://spike-${String(i).padStart(3, "0")}.example`);
  const { db } = await setup(many, 0);
  const failing = new Set(many);
  const fetchImpl = async (u) => (failing.has(u.replace(/\/$/, "")) ? response(500, "Internal Server Error", u) : response(200, PORTFOLIO_HTML, u));
  const render = async (u) => (failing.has(u.replace(/\/$/, "")) ? { status: 500, finalUrl: u, title: "", text: "Internal Server Error", media: false, html: "" } : goodPage(u));
  const feed = many.map((url) => ({ url, name: "Ann Lee" }));
  const check = (t) => health.runHealthCheck({ db, feed, fetchImpl, render, now: at(t), scheduled: "check", alerts: false, doorLimit: 0, log: quiet });
  await check(T0);
  await check(T0 + H);
  let s = await check(T0 + D);
  assert.equal(await hiddenCount(db), 0, "none hidden during the spike");
  assert.ok(s.pace.frozen);
  assert.equal(s.pace.frozenHeld.length, 300);
  assert.equal(await spikeAlert(db), true, "one owner alert");
  // The host is fixed for 280 of them; 20 stay broken. The spike is over once its window has passed.
  for (const u of many.slice(20)) failing.delete(u);
  s = await check(T0 + 2 * D + H);
  assert.equal(s.pace.frozen, false);
  assert.equal(await spikeAlert(db), false, "the alert clears by itself");
  assert.equal(await hiddenCount(db), 0, "the 20 still failing need a full day of evidence from the end of their hold");
  for (const u of many.slice(20)) assert.equal(await col(db, u, "health"), "live", u);
  s = await check(T0 + 3 * D + H);
  assert.equal(await hiddenCount(db), 20, "hidden once their evidence is complete, at the drain's pace");
});

test("F1: a dead domain is still hidden on day 2; a blank page waits for day 8", async () => {
  assert.equal(pool.confirmAfterMs("DNS resolution failed"), D);
  assert.equal(pool.confirmAfterMs("HTTP 402: deployment paused"), D);
  assert.equal(pool.confirmAfterMs('parking phrase: "domain for sale"'), D);
  for (const weak of ["renders blank", "capture blocked: still a gate", "redirects to linkedin.com, not a portfolio", "duplicate of https://a.dev"]) assert.equal(pool.confirmAfterMs(weak), 7 * D, weak);
  const run = (reason, days) => {
    let s = health.nextHealth(null, { ok: false, reason }, at(T0));
    s = health.nextHealth(s, { ok: false, reason }, at(T0 + H));
    return health.nextHealth(s, { ok: false, reason }, at(T0 + days * D)).health;
  };
  assert.equal(run("DNS resolution failed", 1), "down");
  assert.equal(run("renders blank", 1), "suspect");
});

// ---------------------------------------------------------------------------
// F2: a challenge with no words is a bot wall, never "renders blank"

test("F2: a textless challenge (a 202, or a challenge script) is inconclusive; a bot-walled site's blank render too", async () => {
  const site1 = { url: "https://challenged.example", name: "Ann Lee" };
  const empty = { status: 202, finalUrl: "https://challenged.example/", title: "", text: "", media: false, html: "<html><body></body></html>" };
  let r = await health.checkSite(site1, { fetchImpl: async (u) => response(202, "<html><body></body></html>", u), render: async () => empty });
  assert.equal(r.ok, null, r.reason);
  const scripted = '<html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body></body></html>';
  r = await health.checkSite(site1, { fetchImpl: async (u) => response(200, scripted, u), render: async () => ({ ...empty, status: 200, html: scripted }) });
  assert.equal(r.ok, null, r.reason);
  // A plainly blank page is still blank.
  r = await health.checkSite(site1, { fetchImpl: async (u) => response(200, "<div id=root></div>", u), render: async () => ({ ...empty, status: 200, html: "<div id=root></div>" }) });
  assert.equal(r.reason, "renders blank");
  // A site whose capture met a bot wall and that now renders blank: inconclusive, never pooled.
  const { db } = await freshDb();
  const url = "https://walled-blank.example";
  await site(db, url, { status: "error", reason: BOT_WALL_REASON, needsReview: 1, captured: false });
  const fillers = Array.from({ length: 30 }, (_, i) => ({ url: `https://f-${i}.dev`, name: "Ann Lee" }));
  for (const f of fillers) await site(db, f.url, { rubric: answer(true) });
  const fetchImpl = async (u) => (u.startsWith(url) ? response(200, "<div id=root></div>", u) : response(200, PORTFOLIO_HTML, u));
  const render = async (u) => (u.startsWith(url) ? { ...empty, status: 200, html: "" } : goodPage(u));
  for (const d of [0, 1, 2]) await health.runHealthCheck({ db, feed: [{ url, name: "Ann Lee" }, ...fillers], fetchImpl, render, now: at(T0 + d * D), log: quiet });
  assert.equal(await col(db, url, "health"), null);
  assert.equal(Number((await col(db, url, "health_fails")) ?? 0), 0);
});

// ---------------------------------------------------------------------------
// F3: a blocked capture in the pool keeps its captures, and the archive does not cycle it

test("F3: a blocked-capture site hidden in the pool keeps its capture retries; the archive check never brings back a page that still shows no site", async () => {
  const { db } = await freshDb();
  const url = "https://gate.example";
  await site(db, url, { status: "error", reason: "capture blocked: still a gate or loader after the click-through", captured: false });
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'capture blocked: still a gate or loader after the click-through', health_checked_at = 'x' WHERE url = ?", args: [url] });
  await db.execute({ sql: "INSERT INTO health_marks (url, pool_stage, pool_health, pool_checked_at, pool_since) VALUES (?, 3, 'down', 'x', '2026-11-01')", args: [url] });
  const inActive = async () => (await db.execute({ sql: `SELECT 1 FROM portfolios WHERE url = ? AND ${ACTIVE()}`, args: [url] })).rows.length === 1;
  assert.equal(await inActive(), true, "its capture keeps trying, so it can come back");
  // A pool site down for not answering does not.
  await db.execute({ sql: "UPDATE portfolios SET health_reason = 'HTTP 402: deployment paused' WHERE url = ?", args: [url] });
  assert.equal(await inActive(), false);
  // The archive: the page answers but still shows the gate; it stays archived, with what was found.
  const entry = { url, name: "Ann Lee", kind: "down", reason: "capture blocked: still a gate or loader after the click-through", removed: "2026-11-01" };
  const gatePage = "<html><head><title>Ann Lee</title></head><body><button>Enter</button> Ann Lee</body></html>";
  const answers = passesFullCheck({ fetchImpl: async (u) => response(200, gatePage, u), render: async (u) => ({ status: 200, finalUrl: u, title: "Ann Lee", text: "Enter Ann Lee", media: true, html: gatePage }) });
  const a = await answers(url, entry);
  assert.equal(a.ok, false);
  assert.match(a.found.why, /still does not show the site/);
  const r = await planDeadRecheck({ excluded: [entry], now: at(Date.parse("2026-12-01T00:00:00Z")), answers });
  assert.deepEqual([r.back, r.still], [[], [url]]);
  assert.match(r.excluded[0].found.why, /still does not show/);
});

// ---------------------------------------------------------------------------
// F4: a re-registered domain does not come back under the old person's name

test("F4: an archived domain that answers with someone else's site stays archived, recorded for the owner; the same person's site comes back", async () => {
  const entry = { url: "https://ann-lee.example", name: "Ann Lee", kind: "dead", reason: "The domain no longer resolves", removed: "2026-11-01" };
  const spam = "<html><head><title>Best Casino Bonuses 2026</title></head><body><p>" + "Play the best slots and win big today. ".repeat(20) + "</p></body></html>";
  const answersSpam = passesFullCheck({ fetchImpl: async (u) => response(200, spam, u) });
  const a = await answersSpam(entry.url, entry);
  assert.equal(a.ok, false);
  assert.match(a.found.why, /neither the listed person's name nor strong portfolio signals/);
  assert.equal(a.found.title, "Best Casino Bonuses 2026");
  const r = await planDeadRecheck({ excluded: [entry], now: at(Date.parse("2026-12-01T00:00:00Z")), answers: answersSpam });
  assert.deepEqual(r.back, []);
  // The owner's page shows what was found.
  const { db } = await freshDb();
  const page = await healthPool(db, { excluded: r.excluded, now: at(Date.parse("2026-12-02T00:00:00Z")) });
  assert.match(page.archive[0].found.why, /listed person's name/);
  // The same person's portfolio: back.
  const answersOwn = passesFullCheck({ fetchImpl: async (u) => response(200, PORTFOLIO_HTML, u) });
  assert.equal(await answersOwn(entry.url, entry), true);
  // A short name in the body text only is not enough: only the title or the first heading counts for it.
  assert.equal(health.carriesName("Al", { text: "Al builds things" }), false);
});

// ---------------------------------------------------------------------------
// Item 6: the nightly plain look at the pool can only bring a site back sooner

test("item 6: a site fixed between its pool checks is back the next day, not at its next monthly check; a failing one is untouched", async () => {
  const fixed = "https://fixed-day-36.example";
  const still = "https://still-down.example";
  const { db, w, nightly, hourly } = await setup([fixed, still]);
  await nightly(T0);
  for (const u of [fixed, still]) w.mode.set(u, "paused");
  await nightly(T0 + D);
  await hourly(T0 + D + H);
  await hourly(T0 + 2 * D);
  assert.equal(await col(db, fixed, "health"), "down");
  // Day 36 since hidden: its next check is days away.
  const nextOf = async (u) => String((await db.execute({ sql: "SELECT pool_next_at FROM health_marks WHERE url = ?", args: [u] })).rows[0].pool_next_at);
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url IN (?, ?)", args: [at(T0 + 60 * D).toISOString(), fixed, still] });
  w.mode.set(fixed, "ok");
  const s = await nightly(T0 + 36 * D);
  assert.deepEqual(s.poolNudged, [fixed]);
  assert.equal(await nextOf(fixed), at(T0 + 36 * D).toISOString());
  assert.equal(await nextOf(still), at(T0 + 60 * D).toISOString(), "a failing one keeps its date");
  assert.equal(await col(db, still, "health"), "down", "never failed or moved by the look");
  await hourly(T0 + 36 * D + H);
  assert.equal(await col(db, fixed, "health"), "live");
});

// ---------------------------------------------------------------------------
// Item 8: a pool return rejoins the library at once

test("item 8: a site back from the pool is a tier member again at its return, with the rating it had", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-tiers-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  const urls = ["https://tier-a.example", "https://tier-b.example", "https://tier-c.example"];
  for (const u of urls) {
    await db.execute({
      sql: "INSERT INTO portfolios (url, name, status, shot_key, captured_at, ai_rubric, health) VALUES (?, 'Ann Lee', 'live', ?, '2026-10-01 00:00:00', ?, 'live')",
      args: [u, `k${u.length}${u.slice(13, 14)}`, JSON.stringify({ ...answer(true), judged_at: "2026-10-01T00:00:00Z" })],
    });
  }
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, created_at) VALUES (?, ?, 'p', 'human', 'r', '2026-10-05')", args: [urls[0], urls[1]] });
  await refreshTiers(db, { now: T0 });
  const before = (await db.execute({ sql: "SELECT member, mu FROM tier_ratings WHERE url = ?", args: [urls[0]] })).rows[0];
  assert.equal(Number(before.member), 1);
  // In the pool: hidden, out of the library (the trigger).
  const checked = "2026-11-20T00:00:00.000Z";
  await db.execute({ sql: "UPDATE portfolios SET health = 'down', health_reason = 'HTTP 402: deployment paused', health_checked_at = ? WHERE url = ?", args: [checked, urls[0]] });
  await db.execute({ sql: "INSERT INTO health_marks (url, pool_stage, pool_health, pool_checked_at, pool_since, pool_started_at, pool_next_at) VALUES (?, 3, 'down', ?, ?, ?, ?)", args: [urls[0], checked, checked, checked, checked] });
  assert.equal(Number((await db.execute({ sql: "SELECT member FROM tier_ratings WHERE url = ?", args: [urls[0]] })).rows[0].member), 0);
  // Its re-check passes.
  const s = await health.runHealthCheck({ db, feed: [{ url: urls[0], name: "Ann Lee" }], fetchImpl: async (u) => response(200, PORTFOLIO_HTML, u), now: at(Date.parse("2026-11-21T00:00:00Z")), scheduled: "check", alerts: false, doorLimit: 0, log: quiet });
  assert.deepEqual(s.returned.map((r) => r.url), [urls[0]]);
  const after = (await db.execute({ sql: "SELECT member, mu FROM tier_ratings WHERE url = ?", args: [urls[0]] })).rows[0];
  assert.equal(Number(after.member), 1, "a member again at once");
  assert.equal(Number(after.mu), Number(before.mu), "with the rating it had");
});

// ---------------------------------------------------------------------------
// The second review: the name test, a short page's links, the rescue's limits, closed keys on pages

test("item 2: the name test needs every name word as a whole word near the top; non-Latin names match as written; a one-word name in the title or first heading", () => {
  const yes = (name, page) => assert.equal(health.carriesName(name, page), true, `${name}: ${JSON.stringify(page).slice(0, 80)}`);
  const no = (name, page) => assert.equal(health.carriesName(name, page), false, `${name}: ${JSON.stringify(page).slice(0, 80)}`);
  yes("Ann Lee", { title: "Ann Lee | Engineer", text: "I build apps." });
  no("Ann Lee", { title: "Best loans", text: "Ann Arbor lee county loans annual rates" });
  no("Jane Doe", { title: "Jane Smith | Designer", text: "Hello, I am Jane Smith." });
  no("Ali Khan", { title: "Slots", text: "Play alibaba slots, win khanate bonuses" });
  yes("José Martínez", { title: "Jose Martinez", text: "" });
  no("Ann Lee", { title: "Welcome", text: `${"filler words here ".repeat(200)} Ann Lee` }, "only the first 2,000 characters count");
  yes("李小龙", { title: "李小龙的作品集", text: "" });
  no("李小龙", { title: "作品集", text: "欢迎" });
  yes("Bruce 李小龙 Lee", { title: "Bruce Lee", text: "李小龙" });
  yes("Matvey", { title: "Matvey", text: "" });
  yes("Matvey", { title: "Home", heading: "Matvey Ivanov", text: "" });
  no("Matvey", { title: "Home", heading: "Welcome", text: "Matvey made this" }, "a one-word name only in the title or the first heading");
  yes("Al Bo", { title: "Al Bo", text: "" }, "a name of only short words: whole words in the title");
  no("Al Bo", { title: "Home", text: "Al Bo" }, "but only in the title or the first heading");
  no("", { title: "Anything", text: "" }, "no name: never a match");
  // Real portfolios from the benchmark: the surname first, and the surname as an initial.
  yes("Benjamin Cyubahiro", { title: "Cyubahiro Benjamin | Portfolio", text: "" });
  yes("Mnelisi Mthuli", { title: "Home - Mnelisi M. | Senior .NET Developer", text: "" });
  no("Mnelisi Mthuli", { title: "M. Mnelisi", text: "" }, "the first word is never an initial");
  no("Ann Lee", { title: "Ann L", text: "" }, "an initial needs its full stop");
  yes("Yogesh Choudhary Paliyal", { title: "Yogesh Paliyal", text: "" }, "a middle name may be left out");
  no("Yogesh Choudhary Paliyal", { title: "Yogesh Choudhary", text: "" }, "but not the last name");
});

test("item 4: a short page that links out still shows a site to the archive check's capture rule", async () => {
  const entry = { url: "https://minimal.example", name: "Ann Lee", kind: "down", reason: "capture blocked: 9 words and no outbound links", removed: "2026-11-01" };
  const short = '<html><head><title>Ann Lee</title></head><body><h1>Ann Lee</h1><p>Designer and developer in Oslo, building small careful things.</p><a href="https://github.com/annlee">GitHub</a><a href="https://dribbble.com/annlee">Dribbble</a><a href="mailto:ann@example.com">Mail</a></body></html>';
  const answers = passesFullCheck({ fetchImpl: async (u) => response(200, short, u) });
  assert.equal(await answers(entry.url, entry), true);
  // The same words with no links: still no site by the capture's rule.
  const bare = "<html><head><title>Ann Lee</title></head><body><h1>Ann Lee</h1><p>Designer and developer in Oslo, building small careful things.</p></body></html>";
  const a = await passesFullCheck({ fetchImpl: async (u) => response(200, bare, u) })(entry.url, entry);
  assert.equal(a.ok, false);
});

test("item 5: the rescue is only for the scheme and www of the same page; the Visit link goes where the site answers", async () => {
  assert.equal(health.sameSiteAddress("http://ann.example", { final_url: "https://www.ann.example/" }), "https://www.ann.example/");
  assert.equal(health.sameSiteAddress("https://ann.example/work", { final_url: "https://www.ann.example/work/" }), "https://www.ann.example/work/");
  assert.equal(health.sameSiteAddress("https://ann.example", { final_url: "https://ann.example/en/" }), null, "another page of the site");
  assert.equal(health.sameSiteAddress("https://ann.example/a", { final_url: "https://www.ann.example/b" }), null);
  const { visitAddress } = await import("../lib/visit-address.mjs");
  assert.equal(visitAddress("http://ann.example", "https://www.ann.example/"), "https://www.ann.example/");
  assert.equal(visitAddress("http://ann.example", null), "http://ann.example");
  assert.equal(visitAddress("http://ann.example", "https://elsewhere.example/"), "http://ann.example");
  assert.equal(visitAddress("https://ann.example/a", "https://www.ann.example/b"), "https://ann.example/a");
  // Both profile pages use it for their Visit link.
  assert.match(fs.readFileSync("app/p/[slug]/page.tsx", "utf8"), /href=\{visitUrl\}/);
  assert.match(fs.readFileSync("app/p/[slug]/profile-v2.tsx", "utf8"), /href=\{p\.visitUrl\}/);
});

test("item 3: a closed key is never an address on a person's own pages, and admin review lists leave it out", async () => {
  const { isArchivedKey, NO_LONGER_LISTED, NOT_ARCHIVED_SQL } = await import("../lib/archived-key.mjs");
  assert.equal(isArchivedKey("archived:2026-12-13:https://a.example"), true);
  assert.equal(isArchivedKey("https://archived.example"), false);
  assert.equal(NO_LONGER_LISTED, "a site no longer listed");
  const { db } = await freshDb();
  const { ensureReviewSchema, listReviews } = await import("../lib/reviews/store.mjs");
  await ensureReviewSchema(db);
  for (const u of ["https://kept.example", "archived:2026-12-13:https://old.example"]) {
    await db.execute({ sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, status, created_at, decided_at, decided_by) VALUES ('b', ?, 'door_held', 'ranked', 'remove', 0, '{}', 'rejected', '2026-11-01', '2026-11-02', 'admin:owner')", args: [u] });
  }
  const q = await listReviews(db);
  assert.deepEqual(q.decided.map((r) => r.url), ["https://kept.example"]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM status_reviews WHERE ${NOT_ARCHIVED_SQL("url")}`)).rows[0].n), 1);
  // The pages render it as a site no longer listed, with no link.
  const votes = fs.readFileSync("app/votes/page.tsx", "utf8");
  assert.match(votes, /isArchivedKey\(url\)[\s\S]*NO_LONGER_LISTED/);
  assert.match(fs.readFileSync("lib/me.ts", "utf8"), /isArchivedKey\(url\)/);
});

// ---------------------------------------------------------------------------
// The third review: a fault on our side that keeps going, the release-night restart, the archive's
// return test, the reading-fixes branch's verdicts

const BLANK_HTML = "<div id=root></div>";

/**
 * Real portfolios that our reader sees as blank: `perDay` more each day for `days` days, from day 1, the
 * fault never fixed unless `fixed(url, day)` says so. A check of every site each day (and an hour later,
 * the first re-check), through `until`. Returns each day's hidden count and alert, and the database.
 */
async function blankFault({ perDay, days, until, fixed = () => false, spread = null, before = async () => {} }) {
  const sites = spread ?? Array.from({ length: perDay * days }, (_, i) => ({ url: `https://blank-${String(i).padStart(3, "0")}.example`, day: 1 + Math.floor(i / perDay) }));
  const { db } = await setup([], 0);
  // A gated site (`gated`): never shown, its capture blocked and no screenshot (pipeline/not-working.mjs NEVER_SHOWN_SQL).
  for (const s of sites) await site(db, s.url, s.gated ? { rubric: answer(true), status: "error", reason: "capture blocked: 9 words and no outbound links", captured: false } : { rubric: answer(true) });
  await before(db);
  let day = 0;
  // A site's failure now: "blank" (the default) or "social" (it redirects to a LinkedIn profile), or null.
  const failing = (u) => {
    const s = sites.find((x) => u.startsWith(x.url));
    return s && s.day <= day && !fixed(s.url, day) ? (s.kind ?? "blank") : null;
  };
  const LINKEDIN = "https://www.linkedin.com/in/someone";
  const fetchImpl = async (u) => {
    const f = failing(u);
    return f === "social" ? response(200, PORTFOLIO_HTML, LINKEDIN) : response(200, f ? BLANK_HTML : PORTFOLIO_HTML, u);
  };
  const render = async (u) => {
    const f = failing(u);
    if (f === "social") return { ...goodPage(u), finalUrl: LINKEDIN };
    return f ? { status: 200, finalUrl: u, title: "", text: "", media: false, html: BLANK_HTML } : goodPage(u);
  };
  const feed = sites.map((s) => ({ url: s.url, name: "Ann Lee" }));
  const check = (t) => health.runHealthCheck({ db, feed, fetchImpl, render, now: at(t), scheduled: "check", alerts: false, doorLimit: 0, log: quiet });
  const log = [];
  const hiddenOf = async (prefix) => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM portfolios WHERE health = 'down' AND url LIKE ?", args: [`${prefix}%`] })).rows[0].n);
  for (day = 0; day <= until; day++) {
    const s = await check(T0 + day * D);
    const s2 = await check(T0 + day * D + H);
    const alerts = (await activeAlerts(db)).map((a) => a.key);
    log.push({
      day,
      hidden: await hiddenCount(db),
      hiddenSocial: await hiddenOf("https://social-"),
      hiddenGated: await hiddenOf("https://gated-"),
      perDay: s2.pace.weakPerDay,
      alert: alerts.includes(health.SPIKE_ALERT_KEY),
      leak: alerts.includes(health.WEAK_LEAK_ALERT_KEY),
      frozenKinds: s2.pace.weakFrozenKinds.join(",") || s.pace.weakFrozenKinds.join(","),
      held: s2.pace.heldWeak,
      released: s.pace.expired.length + s2.pace.expired.length,
    });
  }
  return { db, log, sites };
}
/** The day-by-day log of a simulation, for the report. */
const printLog = (name, log) => console.log(`${name}\n${log.map((l) => `  day ${l.day}: hidden ${l.hidden}, held ${l.held}, released ${l.released}, frozen [${l.frozenKinds}], weak drain ${l.perDay}/day, freeze alert ${l.alert}, leak alert ${l.leak}`).join("\n")}`);

for (const perDay of [24, 26, 40]) {
  test(`a weak fault that keeps going: blank renders for ${perDay} new real sites a day for a week, never fixed, hide none for two weeks of holding and alert throughout`, async () => {
    const { log } = await blankFault({ perDay, days: 7, until: 21 });
    assert.deepEqual(
      log.filter((l) => l.hidden > 0).map((l) => l.day),
      [],
      "no real site hidden through day 21 (held from day 8; the 14-day release starts on day 22)",
    );
    // The alert stands from the day the count passes the limit to the end, never cleared while it lasts.
    const first = log.findIndex((l) => l.alert);
    assert.ok(first > 0 && first <= 4, `alert from day ${first}`);
    assert.ok(log.slice(first).every((l) => l.alert), "the alert stays up while the held sites still fail");
  });
}

test("a weak freeze lifts when the sites recover: the alert clears, and the few still failing need a full week again, 5 a day", async () => {
  const sites = Array.from({ length: 60 }, (_, i) => ({ url: `https://recover-${String(i).padStart(2, "0")}.example`, day: 1 }));
  const stuck = new Set(sites.slice(0, 7).map((s) => s.url));
  const { log } = await blankFault({ spread: sites, until: 22, fixed: (u, day) => day >= 9 && !stuck.has(u) });
  const at_ = (d) => log[d];
  assert.equal(at_(8).alert, true, "frozen while all 60 look blank");
  assert.equal(at_(8).hidden, 0);
  // Day 9: the held sites are checked daily and 53 pass; at the next run fewer than 50 held still fail, so
  // the freeze lifts and the alert clears.
  assert.equal(at_(9).hidden, 0);
  assert.equal(at_(9).alert, false, "the freeze lifted and the alert cleared");
  assert.equal(at_(15).hidden, 0, "the 7 still failing need a full week from the lift");
  assert.equal(at_(16).hidden, pool.HIDE_WEAK_PER_DAY, "then 5 a day");
  assert.equal(at_(17).hidden, 7);
  assert.ok(log.slice(9).every((l) => !l.alert), "no alert after the lift");
});

test("8 genuinely blank sites over a week are still hidden, with no alert", async () => {
  const sites = Array.from({ length: 8 }, (_, i) => ({ url: `https://really-blank-${i}.example`, day: 1 + Math.floor((i * 7) / 8) }));
  const { log } = await blankFault({ spread: sites, until: 16 });
  assert.equal(log[16].hidden, 8);
  assert.ok(log.every((l) => !l.alert && !l.leak), "neither the freeze alert nor the leak alert");
});

test("the slow leak: blank renders for 6 new real sites a day for 30 days never freeze; the leak alert is raised and slows the weak drain to 1 a day", async () => {
  const { log } = await blankFault({ perDay: 6, days: 30, until: 30 });
  printLog("6 new blank a day for 30 days", log);
  assert.ok(log.every((l) => !l.alert), "6 x 8 = 48: under the freeze, nothing is held");
  const first = log.findIndex((l) => l.leak);
  assert.ok(first > 0, "the leak alert is raised");
  assert.ok(log[first].hidden > pool.WEAK_HIDES_ALERT && log[first].hidden <= pool.WEAK_HIDES_ALERT + pool.HIDE_WEAK_PER_DAY, `on the day the week's weak hides pass ${pool.WEAK_HIDES_ALERT}`);
  assert.ok(log.slice(first + 1).some((l) => l.perDay === pool.HIDE_WEAK_LEAKING_PER_DAY), "the weak drain slows while it is up");
  // 115 by day 30 at 5 a day before; roughly 40 now.
  assert.ok(log[30].hidden >= 30 && log[30].hidden <= 50, `about 40 hidden by day 30 (${log[30].hidden})`);
});

test("a weak freeze never holds forever: 60 sites blank for good are released after 14 days held, drain, and an alert stands every day until the drain ends", async () => {
  const sites = Array.from({ length: 60 }, (_, i) => ({ url: `https://forever-${String(i).padStart(2, "0")}.example`, day: 1 }));
  const { log } = await blankFault({ spread: sites, until: 70 });
  printLog("60 blank for good", log);
  assert.equal(log[8].held, 60, "held from day 8");
  assert.equal(log[21].hidden, 0, "none hidden while held");
  assert.equal(log[22].released, 60, "released after 14 days held");
  assert.equal(log[22].hidden, pool.HIDE_WEAK_PER_DAY, "then the weak drain");
  const done = log.findIndex((l) => l.hidden === 60);
  assert.ok(done > 22, `all hidden by day ${done}`);
  const silent = log.slice(1, done + 1).filter((l) => !l.alert && !l.leak).map((l) => l.day);
  assert.deepEqual(silent, [], "no silent day from day 1 until the drain ends");
  assert.ok(log.slice(1, done + 1).every((l) => l.alert), "the freeze alert itself stays up: held, then released and hiding");
});

test("one fault as two kinds: 45 blank renders and 45 social redirects in 8 days freeze both", async () => {
  const blank = Array.from({ length: 45 }, (_, i) => ({ url: `https://two-blank-${String(i).padStart(2, "0")}.example`, day: 1 + (i % 8) }));
  const social = Array.from({ length: 45 }, (_, i) => ({ url: `https://social-${String(i).padStart(2, "0")}.example`, day: 1 + (i % 8), kind: "social" }));
  const { log } = await blankFault({ spread: [...blank, ...social], until: 12 });
  printLog("45 blank + 45 social", log);
  assert.equal(log[8].frozenKinds, "blank,social-redirect", "both kinds frozen together");
  assert.ok(log.every((l) => l.hidden === 0), "none hidden");
  const first = log.findIndex((l) => l.alert);
  assert.ok(first > 0 && first <= 5, `the alert from the day the two together pass 50 (day ${first})`);
  assert.ok(log.slice(first).every((l) => l.alert), "and it stays up");
});

test("never-shown gated sites: 60 at once trip no freeze and no alert, and leave the weak allowance to visible sites", async () => {
  const gated = Array.from({ length: 60 }, (_, i) => ({ url: `https://gated-${String(i).padStart(2, "0")}.example`, day: 1, gated: true }));
  const visible = Array.from({ length: 5 }, (_, i) => ({ url: `https://visible-blank-${i}.example`, day: 1 }));
  const { log } = await blankFault({ spread: [...gated, ...visible], until: 10 });
  printLog("60 gated + 5 visible blank", log);
  assert.ok(log.every((l) => !l.alert && !l.leak && l.frozenKinds === ""), "no freeze, no alert");
  assert.equal(log[8].hiddenGated, 60, "the gated sites go to the pool on their confirming day");
  assert.equal(log[8].hidden - log[8].hiddenGated, 5, "and the 5 visible ones still have the whole weak allowance");
});

test("release night with old weak rows that include never-shown blocked captures: no leak alert in week two from rows nobody can see", async () => {
  const old = new Date(T0 - 20 * D).toISOString();
  const gated = Array.from({ length: 60 }, (_, i) => ({ url: `https://gated-old-${String(i).padStart(2, "0")}.example`, day: 0, gated: true }));
  const visible = Array.from({ length: 4 }, (_, i) => ({ url: `https://old-blank-${i}.example`, day: 0 }));
  const all = [...gated, ...visible];
  const { log } = await blankFault({
    spread: all,
    until: 16,
    before: async (db) => {
      await ensureReviewSchema(db);
      for (const s of all) {
        await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_fails = 1, health_first_fail_at = ?, health_reason = 'renders blank' WHERE url = ?", args: [old, s.url] });
        await db.execute({ sql: "DELETE FROM health_marks WHERE url = ?", args: [s.url] });
      }
    },
  });
  printLog("release night: 60 never-shown + 4 visible old weak rows", log);
  assert.ok(log.every((l) => !l.alert && !l.leak), "no freeze and no leak alert, week one or week two");
  assert.equal(log[16].hidden, 64, "all of them in the pool by the end");
});

test("8 genuinely blank sites over a week stay silent and are all hidden (fifth review)", async () => {
  const sites = Array.from({ length: 8 }, (_, i) => ({ url: `https://still-blank-${i}.example`, day: 1 + Math.floor((i * 7) / 8) }));
  const { log } = await blankFault({ spread: sites, until: 16 });
  printLog("8 genuinely blank", log);
  assert.equal(log[16].hidden, 8);
  assert.ok(log.every((l) => !l.alert && !l.leak));
});

test("a weak freeze is per kind: a cluster of blank renders leaves another kind's verdicts moving", async () => {
  const blank = Array.from({ length: 60 }, (_, i) => ({ url: `https://cluster-${String(i).padStart(2, "0")}.example`, day: 1 }));
  const social = Array.from({ length: 3 }, (_, i) => ({ url: `https://social-${i}.example`, day: 1, kind: "social" }));
  const { log, db } = await blankFault({ spread: [...blank, ...social], until: 10 });
  assert.match(String(await col(db, social[0].url, "health_reason")), /^redirects to linkedin\.com, not a portfolio/);
  assert.equal(log[8].frozenKinds, "blank", "only the blank kind is frozen");
  assert.equal(log[8].hiddenSocial, 3, "the social redirects are hidden on their own confirming day");
  assert.equal(log[8].hidden, 3, "and none of the blank cluster");
});

test("release night: the old rule's failing rows restart with their first failure kept, so 60 of one kind trip no freeze; a dry run counts them first", async () => {
  const many = Array.from({ length: 60 }, (_, i) => `https://old-suspect-${String(i).padStart(2, "0")}.example`);
  const { db } = await setup(many, 0);
  await ensureReviewSchema(db);
  const old = new Date(T0 - 20 * D).toISOString();
  for (const u of many) {
    await db.execute({ sql: "UPDATE portfolios SET health = 'suspect', health_fails = 1, health_first_fail_at = ?, health_reason = 'HTTP 500' WHERE url = ?", args: [old, u] });
    await db.execute({ sql: "DELETE FROM health_marks WHERE url = ?", args: [u] });
  }
  const fetchImpl = async (u) => response(500, "Internal Server Error", u);
  const render = async (u) => ({ status: 500, finalUrl: u, title: "", text: "Internal Server Error", media: false, html: "" });
  const feed = many.map((url) => ({ url, name: "Ann Lee" }));
  const check = (t, more = {}) => health.runHealthCheck({ db, feed, fetchImpl, render, now: at(t), scheduled: "check", alerts: false, doorLimit: 0, log: quiet, ...more });
  // The owner's count beforehand: the dry run lists them by kind and writes nothing.
  const dry = await check(T0, { dryRun: true });
  assert.equal(dry.restarted.length, 60);
  assert.match(health.healthSummary(dry), /### Restarted on the ladder \(60\)[\s\S]*http-error 60/);
  assert.match(health.healthSummary(dry), /Inside the spike windows: 0 first failed within 48 hours \(0 of them strong evidence[^)]*\), 0 within 8 days/);
  assert.equal(await col(db, many[0], "health_first_fail_at"), old, "the dry run wrote nothing");
  const s0 = await check(T0);
  assert.equal(s0.restarted.length, 60);
  assert.equal(String((await db.execute({ sql: "SELECT pool_first_at FROM health_marks WHERE url = ?", args: [many[0]] })).rows[0].pool_first_at), old, "the first failure is kept");
  await check(T0 + H);
  const s = await check(T0 + D);
  assert.equal(s.pace.frozen, false, "not a spike: none of them is a new failure");
  assert.equal(await spikeAlert(db), false);
  assert.equal(await hiddenCount(db), pool.HIDE_PER_DAY, "the ordinary drain");
  // Rows that started failing recently are counted inside the windows, by evidence.
  const mixed = {
    ...dry,
    restarted: [
      { kind: "http-error", weak: false, in48h: true, in8d: true },
      { kind: "blank", weak: true, in48h: false, in8d: true },
      { kind: "blank", weak: true, in48h: false, in8d: false },
    ],
  };
  assert.match(health.healthSummary(mixed), /Inside the spike windows: 1 first failed within 48 hours \(1 of them strong evidence, counted by the 48-hour spike\), 2 within 8 days \(1 of them weak verdicts, counted by the 8-day weak freeze\)/);
});

test("the reading-fixes branch's verdicts: not the site and the browser's error page are weak (a week), parking and gambling forwards keep the next day", () => {
  // The exact reason strings of fix/read-the-finished-page (pipeline/gate.mjs parkedPage and placeholderPage,
  // pipeline/health.mjs checkSite and redirectVerdict), read with git show on 2026-11-23.
  const weak = [
    "not the site: nginx's default page",
    "not the site: Apache's default page",
    "not the site: IIS's default page",
    "not the site: Caddy's default page",
    "not the site: cPanel's default page",
    "not the site: Plesk's default page",
    "not the site: a maintenance page",
    "not the site: a host's placeholder page",
    "not the site: GitHub Pages' page for no site",
    "not the site: a host's page for an unpublished site",
    "not the site: Streamlit's error page",
    "not the site: a notice that the site was removed",
    "not the site: a not-found page",
    "not the site: an empty directory listing",
    "does not load (the browser's error page)",
  ];
  const strong = [
    "parking page: GoDaddy parking lander",
    "parking page: Sedo parking lander",
    "parking page: a script from a parking service",
    'parking phrase: "this domain is for sale"',
    "redirects to sedo.com",
    "redirects to lucky-slots.example, a gambling site",
    "does not load (net::ERR_NAME_NOT_RESOLVED)",
    "does not load (HTTP 503)",
  ];
  for (const r of weak) assert.equal(pool.confirmAfterMs(r), pool.CONFIRM_WEAK_AFTER_MS, r);
  for (const r of strong) assert.equal(pool.confirmAfterMs(r), pool.CONFIRM_AFTER_MS, r);
  // Each has its own kind in the spike count.
  assert.equal(pool.reasonClass("not the site: nginx's default page"), "not-the-site");
  assert.equal(pool.reasonClass("does not load (the browser's error page)"), "browser-error-page");
  assert.equal(pool.reasonClass("parking page: Sedo parking lander"), "wrong-content");
});

test("the archive's return test: the name or strong portfolio signals; a short name in the title; both missing stays archived with what was found", async () => {
  const back = async (name, html) => passesFullCheck({ fetchImpl: async (u) => response(200, html, u) })("https://archived.example", { url: "https://archived.example", name, kind: "dead", reason: "The domain no longer resolves", removed: "2026-11-01" });
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const portfolioBody = `<h1>@mrashid</h1><a href="#projects">Projects</a><a href="#about">About me</a><a href="mailto:m@r.dev">Contact</a><a href="/resume.pdf">Resume</a><a href="https://github.com/mrashid">GitHub</a><p>${"I build web apps. ".repeat(10)}</p>`;
  // A handle instead of the name: strong signals bring it back (it goes through the door as a new site).
  assert.equal(health.carriesName("Mohammed Al-Rashid", { title: "@mrashid", text: "@mrashid" }), false);
  assert.equal(await back("Mohammed Al-Rashid", page("@mrashid", portfolioBody)), true);
  // A name of only short words, in the title.
  assert.equal(await back("Ed Li", page("Ed Li | Developer", `<p>${"Hello there. ".repeat(10)}</p>`)), true);
  // Neither: stays archived, with what was found shown on /admin/health-pool.
  const none = await back("Ed Li", EMPTY_HTML);
  assert.equal(none.ok, false);
  assert.match(none.found.why, /neither the listed person's name nor strong portfolio signals \(\d of 6\)/);
  // Pages that name the person come back to the door, where a new site is judged (known: the door decides these).
  assert.equal(await back("Alex Chen", page("Best Casino 2026", `<p>Alex Chen wins big. ${"Play slots now. ".repeat(10)}</p>`)), true);
  assert.equal(await back("Ali", page("Ali Baba Slots", `<p>${"Play slots now. ".repeat(10)}</p>`)), true);
  // The veto hook: a detector's answer keeps a passing entry archived, with its reason.
  assert.match(String(returnVeto({ ok: true, moved: true, hijack: true })), /another domain/);
  assert.equal(returnVeto({ ok: true, moved: true, hijack: false }), null);
  RETURN_VETOES.push((r) => (/casino/i.test(String(r.title ?? "")) ? "answers, but a detector calls it a gambling site" : null));
  try {
    const vetoed = await back("Alex Chen", page("Best Casino 2026", `<p>Alex Chen wins big.</p>`));
    assert.equal(vetoed.ok, false);
    assert.match(vetoed.found.why, /gambling/);
  } finally {
    RETURN_VETOES.pop();
  }
});
