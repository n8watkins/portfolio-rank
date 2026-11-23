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
import { passesFullCheck, planDeadRecheck } from "../pipeline/exclusions.mjs";
import { ACTIVE } from "../pipeline/roster.mjs";
import { BOT_WALL_REASON } from "../pipeline/capture-blocked.mjs";
import { activeAlerts } from "../pipeline/alerts.mjs";
import { migrate } from "../lib/schema.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";
import { healthPool } from "../lib/admin/health-pool.mjs";
import { PORTFOLIO_HTML, T0, answer, col, freshDb, site } from "./helpers/door-night.mjs";

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
// F1: the brake on hiding, and a week for weak verdicts

test("F1: a night where 25 sites fail at once hides none of them and alerts the owner; once it is back to a few, they are hidden", async () => {
  const many = Array.from({ length: 25 }, (_, i) => `https://outage-${String(i).padStart(2, "0")}.example`);
  const { db, w, nightly, hourly } = await setup(many, 70);
  await nightly(T0);
  for (const u of many) w.mode.set(u, "paused");
  const F = T0 + D;
  await nightly(F);
  await hourly(F + H);
  const s = await hourly(F + D);
  assert.equal(await hiddenCount(db), 0, "nobody hidden: more than the limit at once");
  assert.ok(s.hideBrake.count > pool.HIDE_PER_DAY);
  assert.equal(s.hideBrake.held.length, s.checked);
  for (const u of many) assert.equal(await col(db, u, "health"), "suspect", `${u} still shown`);
  assert.ok((await activeAlerts(db)).some((a) => a.key === health.HIDE_BRAKE_ALERT_KEY), "the owner's alert stands");
  // The outage was the checker's: most come back at the next day's check. The brake counts the sites still
  // waiting when each batch starts, so the 3 really down are held that day too, and hidden the day after,
  // when the alert clears.
  for (const u of many.slice(3)) w.mode.set(u, "ok");
  await hourly(F + 2 * D);
  for (const u of many.slice(3)) assert.equal(await col(db, u, "health"), "live", u);
  await hourly(F + 3 * D);
  assert.equal(await hiddenCount(db), 3);
  assert.ok(!(await activeAlerts(db)).some((a) => a.key === health.HIDE_BRAKE_ALERT_KEY), "the alert clears");
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
  assert.match(a.found.why, /does not carry the listed person's name/);
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
  // A name with no usable word never matches: it stays archived.
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
