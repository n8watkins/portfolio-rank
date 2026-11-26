// The daily prewarm job's direct measure (lib/psi-job.mjs), the store rule it
// shares with the Worker (lib/psi-store.mjs) and the PageSpeed call both use
// (lib/psi-core.mjs). No network: runs are stand-in results, the database is a
// throwaway file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { measureAndStore, withBackoff } from "../lib/psi-job.mjs";
import { psiCacheKey, storeIfBetter } from "../lib/psi-store.mjs";
import { LEASE_MS, releaseLease, takeLease } from "../lib/cache-lease.mjs";
import { classifyRefusal, readPsi, runPsiCall } from "../lib/psi-core.mjs";
import { quotaDay } from "../pipeline/quota-day.mjs";
import { methodSentence } from "../lib/psi-runs.mjs";

async function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psi-job-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}
const URL_ = "https://a.example/";
const DAY = 24 * 3600 * 1000;
let fetchTimes = 0;
const goodRun = (strategy, perf = 80) => ({
  ok: true,
  strategy,
  scores: { performance: perf, accessibility: 90, "best-practices": 90, seo: 100 },
  metrics: [],
  weight: { bytes: 1, requests: 1 },
  runs: 1,
  runsAttempted: 1,
  runScores: [perf],
  fetchedAt: `t${fetchTimes++}`,
});
const row = async (db, k) => {
  const r = (await db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [k] })).rows[0];
  return r ? { v: r.v === "" ? "" : JSON.parse(String(r.v)), at: Number(r.at) } : null;
};
const counted = async (db) => Number((await db.execute({ sql: "SELECT COALESCE(SUM(n), 0) AS n FROM psi_calls WHERE day = ?", args: [quotaDay().day] })).rows[0].n);

test("a full measure: four calls, both averages stored, the lease taken and given back, the counter equal to the calls", async () => {
  const db = await tempDb();
  const calls = [];
  const sleeps = [];
  let leaseSeenDuring = null;
  const run = async (target, strategy) => {
    calls.push(`${strategy}:${target}`);
    leaseSeenDuring ??= await row(db, `lease:psi:${URL_}`);
    return goodRun(strategy, strategy === "mobile" ? 60 + calls.length : 90);
  };
  const r = await measureAndStore(db, URL_, { run, gapMs: 30_000, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(r, { ok: true, measured: true });
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((c) => c.startsWith("mobile")).length, 2);
  assert.equal(calls.filter((c) => c.startsWith("desktop")).length, 2);
  assert.deepEqual(sleeps, [30_000, 30_000], "a gap between a device's two runs");
  assert.ok(leaseSeenDuring, "the lease was held while it measured");
  assert.equal(await row(db, `lease:psi:${URL_}`), null, "and given back");
  const phone = (await row(db, psiCacheKey("mobile", URL_))).v;
  const desktop = (await row(db, psiCacheKey("desktop", URL_))).v;
  assert.equal(phone.runs, 2);
  assert.equal(phone.runsAttempted, 2);
  assert.equal(phone.strategy, "mobile");
  assert.equal(desktop.runs, 2);
  assert.equal(desktop.scores.performance, 90);
  assert.equal(await counted(db), 4, "the counter equals the calls made");
});

test("only the due device is measured: desktop alone is two calls and leaves the phone row as it was", async () => {
  const db = await tempDb();
  const phoneBefore = { ok: true, runs: 2, runsAttempted: 2, scores: { performance: 50 } };
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, ?)", args: [psiCacheKey("mobile", URL_), JSON.stringify(phoneBefore), 123] });
  const calls = [];
  const r = await measureAndStore(db, URL_, { devices: ["desktop"], run: async (t, s) => (calls.push(s), goodRun(s)), gapMs: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["desktop", "desktop"]);
  assert.deepEqual(await row(db, psiCacheKey("mobile", URL_)), { v: phoneBefore, at: 123 });
  assert.equal((await row(db, psiCacheKey("desktop", URL_))).v.runs, 2);
  assert.equal(await counted(db), 2);
});

test("a site another worker holds is not measured: in_progress, no calls, their lease left alone; an expired lease is taken", async () => {
  const db = await tempDb();
  assert.equal(await takeLease(db, `psi:${URL_}`), true);
  let called = 0;
  const run = async (t, s) => (called++, goodRun(s));
  assert.deepEqual(await measureAndStore(db, URL_, { run }), { ok: false, error: "in_progress" });
  assert.equal(called, 0);
  assert.ok(await row(db, `lease:psi:${URL_}`), "the other's lease is still there");
  assert.equal(await counted(db), 0);
  await db.execute({ sql: "UPDATE cache SET at = ? WHERE k = ?", args: [Date.now() - LEASE_MS - 1000, `lease:psi:${URL_}`] });
  assert.equal((await measureAndStore(db, URL_, { run })).ok, true, "a crashed run's lease expires");
  assert.equal(called, 4);
  assert.equal(await row(db, `lease:psi:${URL_}`), null);
  await releaseLease(db, `psi:${URL_}`);
});

test("the lease is given back when a run throws", async () => {
  const db = await tempDb();
  await assert.rejects(measureAndStore(db, URL_, { run: async () => { throw new Error("boom"); } }), /boom/);
  assert.equal(await row(db, `lease:psi:${URL_}`), null);
});

test("a per-minute refusal is waited out and tried again; every attempt is counted; the retries are bounded", async () => {
  const db = await tempDb();
  const waits = [];
  let n = 0;
  // The first two attempts of the first call are refused per minute, then it works.
  const run = async (t, s) => (++n <= 2 ? { ok: false, error: "rate_limited", strategy: s } : goodRun(s));
  const r = await measureAndStore(db, URL_, { devices: ["mobile"], run, gapMs: 0, waits: [10, 20, 40], sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.ok, true);
  assert.deepEqual(waits, [10, 20], "waited, then retried the same call");
  assert.equal(n, 4, "two refused attempts, the call that worked, and the second run");
  assert.equal(await counted(db), 4);

  // Always refused: the call is retried 3 times, no more, and the measure fails with rate_limited (not "quota").
  const db2 = await tempDb();
  let m = 0;
  const never = async (t, s) => (m++, { ok: false, error: "rate_limited", strategy: s });
  const r2 = await measureAndStore(db2, URL_, { devices: ["mobile"], run: never, gapMs: 0, waits: [0, 0, 0], sleep: async () => {} });
  assert.deepEqual(r2, { ok: false, error: "rate_limited" });
  assert.equal(m, 8, "two runs, each tried once and retried three times");
  assert.equal(await counted(db2), 8);
  assert.equal(await row(db2, psiCacheKey("mobile", URL_)), null, "a per-minute refusal says nothing about the site: no failure row is stored");

  // withBackoff on its own: any other answer comes back at once.
  let k = 0;
  const once = withBackoff(async () => (k++, { ok: false, error: "unreachable" }), { waits: [1, 1, 1], sleep: async () => {} });
  assert.equal((await once("u", "mobile")).error, "unreachable");
  assert.equal(k, 1);
});

test("the day's quota is not retried: one call a device, the error is quota", async () => {
  const db = await tempDb();
  let n = 0;
  const r = await measureAndStore(db, URL_, { run: async (t, s) => (n++, { ok: false, error: "quota", strategy: s }), gapMs: 0, waits: [0, 0, 0], sleep: async () => {} });
  assert.deepEqual(r, { ok: false, error: "quota" });
  assert.equal(n, 2, "phone once, desktop once");
  assert.equal(await counted(db), 2);
  assert.equal(await row(db, `lease:psi:${URL_}`), null);
});

test("one device failing: the other is still stored, and the failure names the device's error", async () => {
  const db = await tempDb();
  const run = async (t, s) => (s === "desktop" ? { ok: false, error: "timeout", strategy: s } : goodRun(s));
  const r = await measureAndStore(db, URL_, { run, gapMs: 0 });
  assert.deepEqual(r, { ok: false, error: "timeout" });
  assert.equal((await row(db, psiCacheKey("mobile", URL_))).v.runs, 2);
  assert.equal((await row(db, psiCacheKey("desktop", URL_))).v.ok, false);
});

test("a good result is not 'measured' when a better stored one was kept", async () => {
  const db = await tempDb();
  const k = psiCacheKey("mobile", URL_);
  const fresh = { ok: true, runs: 2, runsAttempted: 2, scores: { performance: 50 } };
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(fresh), Date.now() - DAY] });
  // One of the two runs fails: a single run cannot replace a fresh average of two.
  let n = 0;
  const run = async (t, s) => (n++ === 1 ? { ok: false, error: "timeout", strategy: s } : goodRun(s));
  const r = await measureAndStore(db, URL_, { devices: ["mobile"], run, gapMs: 0 });
  assert.deepEqual(r, { ok: false, error: "not_stored" });
  assert.equal((await row(db, k)).v.runs, 2);
  assert.equal((await row(db, k)).v.scores.performance, 50);
});

test("store-if-better, in one statement: a single run never replaces an average of two; a failure never replaces a good result; stale and missing rows are replaced", async () => {
  const db = await tempDb();
  const k = psiCacheKey("desktop", URL_);
  const two = { ok: true, runs: 2, runsAttempted: 2, scores: { performance: 70 } };
  const one = { ok: true, runs: 1, runsAttempted: 1, scores: { performance: 40 } };
  const failure = { ok: false, error: "timeout" };
  const now = Date.now();
  assert.equal(await storeIfBetter(db, k, failure, now), true, "a failure is stored where nothing is");
  assert.equal(await storeIfBetter(db, k, failure, now + 1), true, "and replaces a failure");
  assert.equal(await storeIfBetter(db, k, one, now + 2), true, "a good result replaces a failure");
  assert.equal(await storeIfBetter(db, k, failure, now + 3), false, "a failure never replaces a good result");
  assert.equal((await row(db, k)).v.runs, 1);
  assert.equal(await storeIfBetter(db, k, two, now + 4), true, "two runs replace one");
  assert.equal(await storeIfBetter(db, k, one, now + 5), false, "one run never replaces two");
  assert.equal(await storeIfBetter(db, k, { ...two, scores: { performance: 71 } }, now + 6), true, "equal runs: the newer replaces");
  assert.equal((await row(db, k)).v.scores.performance, 71);
  // A row with no run count is one run (an old row): two runs replace it, one run replaces it too.
  await db.execute({ sql: "UPDATE cache SET v = ? WHERE k = ?", args: [JSON.stringify({ ok: true, scores: {} }), k] });
  assert.equal(await storeIfBetter(db, k, one, now + 7), true);
  // One rule: an average of two is never replaced by one run, however old it is (the daily job refreshes it with a new average).
  await db.execute({ sql: "UPDATE cache SET v = ?, at = ? WHERE k = ?", args: [JSON.stringify(two), now - 400 * DAY, k] });
  assert.equal(await storeIfBetter(db, k, one, now + 8), false);
  assert.equal((await row(db, k)).v.runs, 2);
  assert.equal(await storeIfBetter(db, k, two, now + 9), true, "a new average replaces the old one");
});

test("a 400 or 403 about the key is api_key; other 400s and 403s are about the site", async () => {
  const answer = (status, error) => async () => new Response(JSON.stringify({ error }), { status });
  const call = (status, error) => runPsiCall("https://a.example/", "mobile", { key: "K", base: "http://g/r", fetchFn: answer(status, error) });
  assert.equal((await call(400, { message: "API key not valid. Please pass a valid API key." })).error, "api_key");
  assert.equal((await call(400, { message: "Request contains an invalid argument.", details: [{ reason: "API_KEY_INVALID" }] })).error, "api_key");
  assert.equal((await call(403, { message: "Requests from this IP address are blocked.", details: [{ reason: "API_KEY_IP_ADDRESS_BLOCKED" }] })).error, "api_key");
  assert.equal((await call(403, { message: "The caller does not have permission" })).error, "api_key");
  assert.equal((await call(403, { message: "Forbidden" })).error, "psi_403");
  assert.equal((await call(400, { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested." })).error, "unreachable");
});

test("the PageSpeed call: the four categories, the key, a daily refusal and a per-minute one told apart, errors never thrown", async () => {
  const seen = [];
  const answer = (status, body) => async (u) => (seen.push(new URL(u).searchParams), new Response(JSON.stringify(body), { status }));
  const ok = await runPsiCall("https://a.example/", "desktop", {
    key: "K",
    base: "http://google.test/run",
    fetchFn: answer(200, { lighthouseResult: { fetchTime: "T", categories: { performance: { score: 0.5 } }, audits: {} } }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.scores.performance, 50);
  assert.equal(ok.fetchedAt, "T");
  assert.equal(seen[0].get("key"), "K");
  assert.equal(seen[0].get("strategy"), "desktop");
  assert.deepEqual(seen[0].getAll("category"), ["performance", "accessibility", "best-practices", "seo"]);
  const daily = await runPsiCall("https://a.example/", "mobile", { key: "K", base: "http://g/r", fetchFn: answer(429, { error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" } }) });
  assert.equal(daily.error, "quota");
  const minute = await runPsiCall("https://a.example/", "mobile", { key: "K", base: "http://g/r", fetchFn: answer(429, { error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'" } }) });
  assert.equal(minute.error, "rate_limited");
  assert.equal((await runPsiCall("u", "mobile", { key: "K", base: "http://g/r", fetchFn: answer(500, {}) })).error, "unreachable");
  assert.equal((await runPsiCall("u", "mobile", { key: "K", base: "http://g/r", fetchFn: async () => { throw new Error("down"); } })).error, "fetch_error");
  assert.equal((await runPsiCall("u", "mobile", { key: "K", base: "http://g/r", fetchFn: answer(200, {}) })).error, "no_data");
  assert.equal(classifyRefusal(undefined), "rate_limited");
  assert.equal(classifyRefusal("daily limit"), "quota");
  assert.equal(readPsi({}, "mobile").ok, false);
});

test("the job's one-of-two result replaces an expired average (91 days) but not a fresh one (89 days); a visitor's single run replaces neither", async () => {
  const db = await tempDb();
  const k = psiCacheKey("mobile", URL_);
  const now = Date.now();
  const average = { ok: true, runs: 2, runsAttempted: 2, scores: { performance: 70 } };
  const jobOne = { ok: true, runs: 1, runsAttempted: 2, scores: { performance: 40 } }; // the job tried two runs, one was good
  const visitor = { ok: true, runs: 1, runsAttempted: 1, scores: { performance: 30 } };
  const failure = { ok: false, error: "timeout", runsAttempted: 2 };
  const seed = (days) => db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [k, JSON.stringify(average), now - days * DAY] });
  await seed(89);
  assert.equal(await storeIfBetter(db, k, jobOne, now), false, "89 days: still fresh");
  assert.equal((await row(db, k)).v.runs, 2);
  await seed(91);
  assert.equal(await storeIfBetter(db, k, visitor, now), false, "a visitor's single run never replaces an average, however old");
  assert.equal(await storeIfBetter(db, k, failure, now), false, "a failure never replaces a good row");
  assert.equal((await row(db, k)).v.runs, 2);
  assert.equal(await storeIfBetter(db, k, jobOne, now), true, "91 days: the job's one good run replaces it");
  const stored = (await row(db, k)).v;
  assert.equal(stored.runs, 1);
  assert.equal(methodSentence({ ...stored, ranAt: "2026-11-25T10:00:00Z" }), "One Lighthouse run on 25 Nov 2026", "the row reads as one run");
  // And a visitor's single run still replaces nothing better than itself: equal runs replace.
  assert.equal(await storeIfBetter(db, k, visitor, now + 1), true);
});
