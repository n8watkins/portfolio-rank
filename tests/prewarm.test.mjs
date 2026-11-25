// The prewarm job must fail loudly: these drive scripts/lib/prewarm.mjs with a
// stand-in fetch, and run scripts/prewarm-metrics.mjs itself against a local
// stand-in for the site to check its exit code and GitHub job summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { runPrewarm, classify } from "../scripts/lib/prewarm.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { FRESHNESS_TABLES } from "../lib/freshness.mjs";
import feed from "../data/feed.json" with { type: "json" };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Real roster URLs: the script only prewarms sites on data/feed.json.
const urls = feed.slice(0, 4).map((p) => p.url);
const quiet = () => {};

test("every lookup failing exits 1 and names the most common error", async () => {
  const fetchFn = async (u) => (u.includes("/api/psi") ? json(200, { ok: false, error: "timeout" }) : json(200, { ok: false, error: "unreachable" }));
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /8 of 8 lookups failed; most common error: (timeout|unreachable) \(4\)/);
  assert.deepEqual(r.stats.psi, { attempted: 4, ok: 0, failed: 4, errors: { timeout: 4 } });
  assert.match(r.summary, /\| psi \| 4 \| 0 \| 4 \| timeout 4 \|/);
  assert.match(r.summary, /PageSpeed: 0 site\(s\) measured \(a new result stored\), 4 not measured \(timeout 4\)\./);
});

test("a quota refusal stops the job at once: no more sites are started, and it reports why", async () => {
  const asked = [];
  const fetchFn = async (u) => {
    asked.push(u);
    return u.includes("/api/psi") ? json(200, { ok: false, error: "quota" }) : json(200, { ok: true });
  };
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /^STOPPED: PageSpeed refused \(quota\) at site 1 of 4; 3 site\(s\) not tried; 0 measured\./);
  assert.equal(r.stats.psi.attempted, 1);
  assert.equal(asked.length, 2, "one site's inspect and psi, nothing after");
  assert.match(r.summary, /3 not tried/);
});

test("a site counts as measured only when a new result was stored", async () => {
  const bodies = [
    { ok: true, measured: true }, // stored
    { ok: true }, // answered with a result it did not just measure
    { ok: false, error: "in_progress" }, // another measure holds the site
    { ok: false, error: "unreachable" }, // the measure failed
  ];
  let i = 0;
  const fetchFn = async (u) => (u.includes("/api/psi") ? json(200, bodies[i++]) : json(200, { ok: true }));
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.stats.psi.ok, 1);
  assert.deepEqual(r.stats.psi.errors, { not_stored: 1, in_progress: 1, unreachable: 1 });
  assert.match(r.summary, /PageSpeed: 1 site\(s\) measured \(a new result stored\), 3 not measured \(/);
});

test("more than half failing exits 1; half or fewer exits 0", async () => {
  // psi all fail (4), inspect: 1 of 4 fails -> 5 of 8 failed.
  let n = 0;
  const mostlyBad = async (u) =>
    u.includes("/api/psi") ? json(200, { ok: false, error: "timeout" }) : n++ === 0 ? json(500, {}) : json(200, { ok: true });
  const bad = await runPrewarm({ urls, base: "http://x", fetchFn: mostlyBad, pauseMs: 0, log: quiet });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.verdict, /5 of 8 lookups failed; most common error: timeout \(4\)/);
  assert.deepEqual(bad.stats.inspect.errors, { http_500: 1 });

  // psi all fail (4), inspect all fine -> exactly half: not "more than half".
  const half = async (u) => (u.includes("/api/psi") ? json(503, {}) : json(200, { ok: true }));
  const ok = await runPrewarm({ urls, base: "http://x", fetchFn: half, pauseMs: 0, log: quiet });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stats.psi.errors.http_503, 4);
});

test("network errors and timeouts are counted, not thrown", async () => {
  const fetchFn = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const r = await runPrewarm({ urls: urls.slice(0, 1), base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.stats.inspect.errors, { timeout: 1 });
});

test("sites go several at a time, one site's lookups stay in order, and only /api/psi carries the internal token", async () => {
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const fetchFn = async (u, init) => {
    seen.push({ u, headers: init?.headers });
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return json(200, { ok: true, measured: true });
  };
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, pauseMs: 0, concurrency: 3, psiToken: "tok", log: quiet });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stats.psi.attempted, 4);
  assert.equal(r.stats.inspect.attempted, 4);
  assert.equal(peak, 3, "three sites at once, no more");
  for (const { u, headers } of seen) assert.equal(headers?.["x-portfoliorank-internal"], u.includes("/api/psi") ? "tok" : undefined, u);
  for (const url of urls) {
    const mine = seen.filter((s) => s.u.includes(encodeURIComponent(url)));
    assert.deepEqual(mine.map((s) => (s.u.includes("/api/psi") ? "psi" : "inspect")), ["inspect", "psi"]);
  }
});

test("error classes", () => {
  assert.equal(classify("unknown_url"), "not_on_roster");
  assert.equal(classify("psi_403"), "http_403");
  assert.equal(classify("http_404"), "http_404");
  assert.equal(classify("API key not valid. Please pass a valid API key."), "api_key");
  assert.equal(classify("fetch failed"), "unreachable");
});

// A tier-C site (prewarmed: Gemini's letter no longer gates Lighthouse),
// roster sites that must never be prewarmed, and one with an old PSI result.
const [tierC, fresh, down, old, notPortfolio, failedGrade, oneRun, twoRuns, failedLong, failedRecent, noDesktop, singleDesktop, forced] = feed.slice(4, 17).map((p) => p.url);
const DAY = 86400000;

async function runScript(handler, { limit = 4, env = {} } = {}) {
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "prewarm-"));
  const dbFile = join(dir, "db.sqlite");
  const db = createClient({ url: `file:${dbFile}` });
  await ensureRosterSchema(db);
  const add = (url, tier, extra = {}) =>
    db.execute({
      sql: "INSERT INTO portfolios (url, status, ai_rubric, health) VALUES (?, ?, ?, ?)",
      args: [url, extra.status ?? "live", JSON.stringify(extra.rubric ?? { tier }), extra.health ?? null],
    });
  for (const [i, u] of urls.entries()) await add(u, ["S", "A", "B", "A"][i]);
  await add(tierC, "C");
  await add(fresh, "A");
  await add(down, "A", { health: "down" });
  await add(old, "S");
  await add(notPortfolio, "D", { rubric: { tier: "D", is_portfolio: false } });
  await add(failedGrade, null, { rubric: { error: "no_usable_captures" } });
  // Gone from the roster (delisted on start), or a variant of a roster URL.
  for (const u of ["https://left-upstream.example", `${urls[0]}/`]) await add(u, "S");
  const now = Date.now();
  const good = { ok: true, runs: 2, runsAttempted: 2 };
  const put = (k, v, at) => db.execute({ sql: "INSERT INTO cache VALUES (?, ?, ?)", args: [k, JSON.stringify(v), at] });
  const both = async (u, phone, at, desktop = good) => {
    await add(u, "A");
    await put(`psi:${u}`, phone, at);
    if (desktop) await put(`psi-desktop:${u}`, desktop, at);
  };
  // Not due: measured a day ago with two runs a device; and one whose failure is 10 minutes old (retried after an hour).
  await put(`psi:${fresh}`, good, now - DAY);
  await put(`psi-desktop:${fresh}`, good, now - DAY);
  await both(twoRuns, good, now - 2 * DAY);
  await both(failedRecent, { ok: false, error: "timeout" }, now - 10 * 60 * 1000, null);
  // Due, oldest first: older than the 90 days a result is kept; no desktop result; a desktop result of one run;
  // a phone result of one run (stored before two runs a device, or by a speed check); a failure older than its hour.
  await put(`psi:${old}`, good, now - 100 * DAY);
  await put(`psi-desktop:${old}`, good, now - 100 * DAY);
  await both(noDesktop, good, now - 5 * DAY, null);
  await both(singleDesktop, good, now - 4 * DAY, { ok: true });
  await both(oneRun, { ok: true, scores: {} }, now - 3 * DAY);
  await both(failedLong, { ok: false, error: "timeout" }, now - 2 * DAY, null);
  // Asked for again by the admin (Re-measure) after its good result: first, though its result is newer than all of those.
  await both(forced, good, now - 10 * DAY);
  for (const sql of FRESHNESS_TABLES) await db.execute(sql);
  await db.execute({ sql: "INSERT INTO site_freshness (url, forced_at) VALUES (?, ?)", args: [forced, now - DAY] });
  db.close();
  const summaryFile = join(dir, "summary.md");
  const child = spawn(process.execPath, ["scripts/prewarm-metrics.mjs", `--limit=${limit}`], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${dbFile}`,
      TURSO_AUTH_TOKEN: "",
      PROD_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_STEP_SUMMARY: summaryFile,
      PREWARM_PAUSE_MS: "0",
      AUTH_SECRET: "prewarm-test-secret",
      // One site at a time, so the order requested is the queue's order.
      PREWARM_CONCURRENCY: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", r));
  server.close();
  const psi = requested
    .filter((u) => u.startsWith("/api/psi"))
    .map((u) => new URL(u, "http://x").searchParams.get("url"));
  return { code, summary: readFileSync(summaryFile, "utf8"), err, psi };
}

test("the script exits 1 and writes the job summary when PageSpeed refuses (quota), after the first site", async () => {
  const r = await runScript((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/api/psi") ? { ok: false, error: "Quota exceeded for quota metric 'Queries'" } : { ok: false, error: "unreachable" }));
  });
  assert.equal(r.code, 1);
  assert.match(r.summary, /## Prewarm metrics/);
  assert.match(r.summary, /\| psi \| 1 \| 0 \| 1 \| quota 1 \|/);
  assert.match(r.err, /::error::STOPPED: PageSpeed refused \(quota\) at site 1 of 4; 3 site\(s\) not tried/);
  assert.equal(r.psi.length, 1, "no site after the refusal");
});

test("roster rejections are reported as their own reason", async () => {
  const fetchFn = async () => json(403, { ok: false, error: "unknown_url" });
  const r = await runPrewarm({ urls: urls.slice(0, 2), base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /most common error: not_on_roster \(4\)/);
});

test("the script exits 0 when lookups succeed", async () => {
  const r = await runScript((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, measured: true }));
  });
  assert.equal(r.code, 0);
  assert.match(r.summary, /OK: 8 of 8 lookups succeeded/);
  assert.match(r.summary, /PageSpeed: 4 site\(s\) measured/);
});

test("the script picks what is due by the check rule, whatever the letter: asked-for first, never measured, then the oldest", async () => {
  const r = await runScript((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, measured: true }));
  }, { limit: 50 });
  assert.equal(r.code, 0);
  // The admin's Re-measure first; never measured (by URL, tier C included);
  // then by age: past 90 days, no desktop result, a desktop result of one run,
  // a phone result of one run, a failure older than an hour. Not: measured with
  // two runs a device, a failure 10 minutes old, confirmed down, "not a
  // portfolio", a failed grade, delisted, or not on the roster.
  assert.deepEqual(r.psi, [forced, ...[...urls, tierC].sort(), old, noDesktop, singleDesktop, oneRun, failedLong]);
});

test("the script cannot measure without AUTH_SECRET: it says so and fails before any call", async () => {
  const r = await runScript((req, res) => res.end("{}"), { env: { AUTH_SECRET: "" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /AUTH_SECRET is not set/);
  assert.equal(r.psi.length, 0);
});
