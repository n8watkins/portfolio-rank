// The daily job's queue (scripts/lib/prewarm.mjs prewarmQueue) with the tries
// it keeps (psi_attempts): untried sites before retried ones, the backoff of
// 1, 3, 7 and 30 days after failed tries, a forced re-measure tried once at
// once, a new stored result clearing the count, and sites that are hidden or
// were removed by their owner left out. In-process: a throwaway database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { ACTIVE, ensureRosterSchema } from "../pipeline/roster.mjs";
import { FRESHNESS_TABLES } from "../lib/freshness.mjs";
import { PSI_CALL_TABLES, recordFailedAttempt } from "../lib/psi-calls.mjs";
import { BACKOFF_DAYS, backoffMs } from "../lib/psi-pacing.mjs";
import { measureAndStore } from "../lib/psi-job.mjs";
import { prewarmQueue } from "../scripts/lib/prewarm.mjs";

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const GOOD = { ok: true, runs: 2, runsAttempted: 2 };

async function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prewarm-queue-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await ensureRosterSchema(db);
  for (const sql of [...FRESHNESS_TABLES, ...PSI_CALL_TABLES]) await db.execute(sql);
  await db.execute(`CREATE TABLE IF NOT EXISTS portfolio_owner (url TEXT PRIMARY KEY, hide_grade INTEGER NOT NULL DEFAULT 0, removed_at TEXT, remove_after TEXT, removed_by TEXT, updated_at TEXT NOT NULL DEFAULT '')`);
  return db;
}
let n = 0;
const site = async (db, { phone, desktop = phone ? GOOD : undefined, at = NOW - 5 * DAY, status = "live" } = {}) => {
  const url = `https://queue-${n++}.example/`;
  await db.execute({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, ?, ?)", args: [url, status, JSON.stringify({ tier: "A" })] });
  if (phone) await db.execute({ sql: "INSERT INTO cache VALUES (?, ?, ?)", args: [`psi:${url}`, JSON.stringify(phone), at] });
  if (desktop) await db.execute({ sql: "INSERT INTO cache VALUES (?, ?, ?)", args: [`psi-desktop:${url}`, JSON.stringify(desktop), at] });
  return url;
};
const attempt = (db, url, device, at, fails) => db.execute({ sql: "INSERT OR REPLACE INTO psi_attempts (url, device, at, fails) VALUES (?, ?, ?, ?)", args: [url, device, at, fails] });
const queue = async (db, limit = 400) => prewarmQueue(db, { active: ACTIVE, now: NOW, limit });
const urlsOf = (rows) => rows.map((r) => r.url);

test("the backoff after failed tries is 1, 3, 7 then 30 days, per device", async () => {
  assert.deepEqual(BACKOFF_DAYS, [1, 3, 7, 30]);
  assert.deepEqual([1, 2, 3, 4, 9].map((f) => backoffMs(f) / DAY), [1, 3, 7, 30, 30]);
  const db = await tempDb();
  for (const [fails, days] of [[1, 1], [2, 3], [3, 7], [4, 30], [6, 30]]) {
    // A phone result of one run is due; its last try failed `fails` times in a row.
    const waiting = await site(db, { phone: { ok: true, scores: {} } });
    const ready = await site(db, { phone: { ok: true, scores: {} } });
    await attempt(db, waiting, "mobile", NOW - days * DAY + HOUR, fails);
    await attempt(db, ready, "mobile", NOW - days * DAY - HOUR, fails);
    const got = urlsOf(await queue(db));
    assert.ok(!got.includes(waiting), `${fails} failures: waits ${days} days, an hour short`);
    assert.ok(got.includes(ready), `${fails} failures: due once ${days} days have passed`);
  }
});

test("a device waiting out its backoff does not hold back the site's other device", async () => {
  const db = await tempDb();
  // Phone: one run, its try failed an hour ago (waits a day). Desktop: missing, never tried.
  const u = await site(db, { phone: { ok: true, scores: {} }, desktop: null });
  await attempt(db, u, "mobile", NOW - HOUR, 1);
  assert.deepEqual(await queue(db), [{ url: u, devices: ["desktop"] }]);
});

test("untried sites come before retried ones, then never measured, then the oldest", async () => {
  const db = await tempDb();
  const retriedOld = await site(db, { phone: GOOD, at: NOW - 200 * DAY });
  await attempt(db, retriedOld, "mobile", NOW - 2 * DAY, 1);
  await attempt(db, retriedOld, "desktop", NOW - 2 * DAY, 1);
  const untriedOld = await site(db, { phone: GOOD, at: NOW - 100 * DAY });
  const untriedNever = await site(db, {});
  const retriedNever = await site(db, {});
  await attempt(db, retriedNever, "mobile", NOW - 4 * DAY, 2);
  await attempt(db, retriedNever, "desktop", NOW - 4 * DAY, 2);
  // Without tries the oldest result would lead; the sites that failed yesterday and the day before wait behind the untried ones.
  assert.deepEqual(urlsOf(await queue(db)), [untriedNever, untriedOld, retriedNever, retriedOld]);
});

test("a forced re-measure is tried once at once, then follows the backoff; a failure of it does not bring it back every day", async () => {
  const db = await tempDb();
  const fresh = await site(db, { phone: GOOD, at: NOW - 10 * DAY });
  const never = await site(db, {});
  await db.execute({ sql: "INSERT INTO site_freshness (url, forced_at) VALUES (?, ?)", args: [fresh, NOW - HOUR] });
  // Asked for after its result, never tried since: first, ahead of the never-measured site.
  assert.deepEqual(await queue(db), [{ url: fresh, devices: ["mobile", "desktop"] }, { url: never, devices: ["mobile", "desktop"] }]);
  // Its try failed (after the request): it waits a day, like any failed try; the request does not bring it back at the front.
  await attempt(db, fresh, "mobile", NOW - 30 * 60 * 1000, 1);
  await attempt(db, fresh, "desktop", NOW - 30 * 60 * 1000, 1);
  assert.deepEqual(urlsOf(await queue(db)), [never]);
  // A day later it is due again (the request is still unanswered), after the sites never tried.
  const later = await prewarmQueue(db, { active: ACTIVE, now: NOW + DAY, limit: 400 });
  assert.deepEqual(urlsOf(later), [never, fresh]);
  // Asked for again after that failed try: tried promptly again, first.
  await db.execute({ sql: "UPDATE site_freshness SET forced_at = ? WHERE url = ?", args: [NOW - 10 * 60 * 1000, fresh] });
  await attempt(db, fresh, "mobile", NOW - 3 * HOUR, 3);
  await attempt(db, fresh, "desktop", NOW - 3 * HOUR, 3);
  assert.deepEqual(urlsOf(await queue(db)), [fresh, never]);
});

test("a re-measure that returns one run against a stored average is a failed try: the site backs off instead of coming back every day", async () => {
  const db = await tempDb();
  const u = await site(db, { phone: GOOD, at: NOW - 10 * DAY });
  await db.execute({ sql: "INSERT INTO site_freshness (url, forced_at) VALUES (?, ?)", args: [u, NOW - DAY] });
  // One of the two runs of each device fails: a single run does not replace the stored average.
  const seen = {};
  const run = async (target, strategy) => ((seen[strategy] = (seen[strategy] ?? 0) + 1) === 2 ? { ok: false, error: "timeout", strategy } : { ok: true, strategy, scores: { performance: 50 }, metrics: [], runs: 1, runsAttempted: 1, fetchedAt: `${strategy}1` });
  const r = await measureAndStore(db, u, { run, gapMs: 0, now: () => NOW });
  assert.deepEqual(r, { ok: false, error: "not_stored" });
  const rows = (await db.execute({ sql: "SELECT device, fails, at FROM psi_attempts WHERE url = ? ORDER BY device", args: [u] })).rows.map((x) => [x.device, Number(x.fails), Number(x.at)]);
  assert.deepEqual(rows, [["desktop", 1, NOW], ["mobile", 1, NOW]]);
  assert.deepEqual(await queue(db), [], "not due again until a day has passed");
  assert.deepEqual(urlsOf(await prewarmQueue(db, { active: ACTIVE, now: NOW + DAY + HOUR, limit: 400 })), [u]);
});

test("a failed measure notes the try per device and counts failures in a row; a new stored result clears them", async () => {
  const db = await tempDb();
  const u = await site(db, {});
  const bad = async (t, s) => ({ ok: false, error: "unreachable", strategy: s });
  await measureAndStore(db, u, { run: bad, gapMs: 0, now: () => NOW });
  await measureAndStore(db, u, { run: bad, gapMs: 0, now: () => NOW + DAY });
  let rows = (await db.execute({ sql: "SELECT device, fails, at FROM psi_attempts WHERE url = ? ORDER BY device", args: [u] })).rows.map((x) => [x.device, Number(x.fails), Number(x.at)]);
  assert.deepEqual(rows, [["desktop", 2, NOW + DAY], ["mobile", 2, NOW + DAY]]);
  // Only one device is measured and fails: the other's count is not touched.
  await measureAndStore(db, u, { devices: ["mobile"], run: bad, gapMs: 0, now: () => NOW + 5 * DAY });
  rows = (await db.execute({ sql: "SELECT device, fails FROM psi_attempts WHERE url = ? ORDER BY device", args: [u] })).rows.map((x) => [x.device, Number(x.fails)]);
  assert.deepEqual(rows, [["desktop", 2], ["mobile", 3]]);
  // A new stored result clears the count.
  const good = async (t, s) => ({ ok: true, strategy: s, scores: { performance: 80 }, metrics: [], runs: 1, runsAttempted: 1, fetchedAt: `${s}${Math.random()}` });
  assert.equal((await measureAndStore(db, u, { run: good, gapMs: 0, now: () => NOW + 9 * DAY })).ok, true);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM psi_attempts WHERE url = ?", args: [u] })).rows[0].n, 0);
  await recordFailedAttempt(db, u, "mobile", NOW);
  assert.equal((await db.execute({ sql: "SELECT fails FROM psi_attempts WHERE url = ?", args: [u] })).rows[0].fails, 1);
});

test("errors that say nothing about the site note no try and store no failure: a bad key, the day's quota, a per-minute limit", async () => {
  for (const error of ["api_key", "quota", "rate_limited"]) {
    const db = await tempDb();
    const u = await site(db, {});
    const r = await measureAndStore(db, u, { run: async (t, s) => ({ ok: false, error, strategy: s }), gapMs: 0, waits: [0, 0, 0], sleep: async () => {}, now: () => NOW });
    assert.deepEqual(r, { ok: false, error });
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM psi_attempts")).rows[0].n, 0, `${error}: no try noted`);
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM cache WHERE k LIKE 'psi%'", args: [] })).rows[0].n, 0, `${error}: no failure row for the site`);
    assert.deepEqual(urlsOf(await queue(db)), [u], `${error}: still first in line tomorrow`);
  }
});

test("sites whose owner removed them, and hidden ones, are not measured; the limit applies after that", async () => {
  const db = await tempDb();
  const removed = await site(db, {});
  const kept = await site(db, {});
  const down = await site(db, {});
  const held = await site(db, {});
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES (?, ?, ?)", args: [removed, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"] });
  await db.execute({ sql: "UPDATE portfolios SET health = 'down' WHERE url = ?", args: [down] });
  // A removal still in its hold is not applied yet: the site is still measured.
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, remove_after, updated_at) VALUES (?, ?, ?)", args: [held, "2099-01-01T00:00:00Z", "2026-11-01T00:00:00Z"] });
  assert.deepEqual(urlsOf(await queue(db)).sort(), [kept, held].sort());
  assert.equal((await queue(db, 1)).length, 1, "the limit counts only sites that may be measured");
  // The same site under another spelling of its address is removed too.
  const spelled = await site(db, {});
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, removed_at, updated_at) VALUES (?, ?, ?)", args: [spelled.replace("https://", "https://www."), "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"] });
  assert.ok(!urlsOf(await queue(db)).includes(spelled));
});
