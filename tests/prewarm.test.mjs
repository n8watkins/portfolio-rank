// The prewarm job must fail loudly: these drive scripts/lib/prewarm.mjs with
// stand-ins, and run scripts/prewarm-metrics.mjs itself against a local
// stand-in for the site (the polish check) and for Google PageSpeed, to check
// what it measures and writes, its exit code and its GitHub job summary.
// The job calls PageSpeed directly and writes the database: no app secret and
// no request to the app's /api/psi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { runPrewarm, classify, RATE_LIMITED_STREAK_STOP } from "../scripts/lib/prewarm.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { FRESHNESS_TABLES } from "../lib/freshness.mjs";
import { PSI_CALL_TABLES } from "../lib/psi-calls.mjs";
import { quotaDay } from "../pipeline/quota-day.mjs";
import feed from "../data/feed.json" with { type: "json" };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Real roster URLs: the script only prewarms sites on data/feed.json.
const urls = feed.slice(0, 4).map((p) => p.url);
const quiet = () => {};
const inspectOk = async () => json(200, { ok: true });
const measured = async () => ({ ok: true, measured: true });

test("every lookup failing exits 1 and names the most common error", async () => {
  const fetchFn = async () => json(200, { ok: false, error: "unreachable" });
  const measure = async () => ({ ok: false, error: "timeout" });
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, measure, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /^FAILED: every Lighthouse measure failed \(4 tried; most common error: timeout \(4\)\)\./);
  assert.deepEqual(r.stats.psi, { attempted: 4, ok: 0, failed: 4, errors: { timeout: 4 } });
  assert.match(r.summary, /\| psi \| 4 \| 0 \| 4 \| timeout 4 \|/);
  assert.match(r.summary, /PageSpeed: 0 site\(s\) measured \(a new result stored\), 4 not measured \(timeout 4\)\./);
});

test("the day's quota stops the job at once: no more sites are started, and it reports why", async () => {
  const asked = [];
  const measure = async ({ url }) => (asked.push(url), { ok: false, error: "quota" });
  const r = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /^STOPPED: PageSpeed refused the day's quota at site 1 of 4; 3 site\(s\) not tried; 0 measured\./);
  assert.equal(r.stats.psi.attempted, 1);
  assert.deepEqual(asked, [urls[0]]);
  assert.match(r.summary, /3 not tried/);
});

test("a per-minute refusal is not the daily quota: the job goes on, and stops only after a long streak of them", async () => {
  const some = urls.slice(0, 3);
  const r = await runPrewarm({ urls: some, base: "http://x", fetchFn: inspectOk, measure: async () => ({ ok: false, error: "rate_limited" }), pauseMs: 0, log: quiet });
  assert.equal(r.stats.psi.attempted, 3, "every site was tried");
  assert.equal(r.stats.psi.errors.rate_limited, 3);
  assert.doesNotMatch(r.verdict, /STOPPED/);
  // A streak the size of RATE_LIMITED_STREAK_STOP stops it (nothing is working).
  const many = feed.slice(0, RATE_LIMITED_STREAK_STOP + 5).map((p) => p.url);
  const streak = await runPrewarm({ urls: many, base: "http://x", fetchFn: inspectOk, measure: async () => ({ ok: false, error: "rate_limited" }), pauseMs: 0, log: quiet });
  assert.equal(streak.stats.psi.attempted, RATE_LIMITED_STREAK_STOP);
  assert.match(streak.verdict, /per-minute limit for 10 sites in a row/);
  assert.equal(streak.exitCode, 1);
  // A success in between resets it.
  let n = 0;
  const mixed = await runPrewarm({ urls: many, base: "http://x", fetchFn: inspectOk, measure: async () => (++n % 5 === 0 ? { ok: true, measured: true } : { ok: false, error: "rate_limited" }), pauseMs: 0, log: quiet });
  assert.equal(mixed.stats.psi.attempted, many.length);
});

test("a site counts as measured only when a new result was stored", async () => {
  const answers = [
    { ok: true, measured: true }, // stored
    { ok: false, error: "not_stored" }, // a better result was kept
    { ok: false, error: "in_progress" }, // another worker holds the site
    { ok: false, error: "unreachable" }, // the measure failed
  ];
  let i = 0;
  const r = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure: async () => answers[i++], pauseMs: 0, log: quiet });
  assert.equal(r.stats.psi.ok, 1);
  assert.deepEqual(r.stats.psi.errors, { not_stored: 1, in_progress: 1, unreachable: 1 });
  assert.match(r.summary, /PageSpeed: 1 site\(s\) measured \(a new result stored\), 3 not measured \(/);
});

test("a measure that throws is a failure with its reason, not a crash", async () => {
  const r = await runPrewarm({ urls: urls.slice(0, 1), base: "http://x", fetchFn: inspectOk, measure: async () => { throw new Error("database is locked"); }, pauseMs: 0, log: quiet });
  assert.equal(r.stats.psi.failed, 1);
  assert.deepEqual(r.stats.psi.errors, { "database is locked": 1 });
});

test("the share of failing sites does not decide: red only when the job could not do its work", async () => {
  // Most sites fail (3 of 4 measures, 3 of 4 polish checks) but one is measured: green, with the counts in the summary.
  let n = 0;
  const someFail = async () => (n++ === 0 ? { ok: true, measured: true } : { ok: false, error: "timeout" });
  let k = 0;
  const inspectMostlyBad = async () => (k++ === 0 ? json(200, { ok: true }) : json(500, {}));
  const green = await runPrewarm({ urls, base: "http://x", fetchFn: inspectMostlyBad, measure: someFail, pauseMs: 0, log: quiet });
  assert.equal(green.exitCode, 0);
  assert.match(green.verdict, /^OK: 2 of 8 lookups succeeded, 6 did not \(most common error: /);
  assert.match(green.summary, /PageSpeed: 1 site\(s\) measured \(a new result stored\), 3 not measured \(timeout 3\)\./);
  assert.deepEqual(green.stats.inspect.errors, { http_500: 3 });

  // Every polish check failing (the site is not answering) is red on its own.
  const inspectDown = async () => json(503, {});
  const red = await runPrewarm({ urls, base: "http://x", fetchFn: inspectDown, measure: measured, pauseMs: 0, log: quiet });
  assert.equal(red.exitCode, 1);
  assert.match(red.verdict, /^FAILED: every polish check failed \(4 tried; most common error: http_503 \(4\)\)/);
});

test("the day's quota after something was measured is a green job that says it stopped", async () => {
  let n = 0;
  const measure = async () => (n++ < 2 ? { ok: true, measured: true } : { ok: false, error: "quota" });
  const r = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 0, "2 sites were measured before the quota ran out");
  assert.match(r.verdict, /^STOPPED: PageSpeed refused the day's quota at site 3 of 4; 1 site\(s\) not tried; 2 measured\./);
  assert.match(r.summary, /PageSpeed: 2 site\(s\) measured .*1 not tried/);
});

test("a key Google refuses stops the job at once, red, and names the secret", async () => {
  const asked = [];
  const measure = async ({ url }) => (asked.push(url), { ok: false, error: "api_key" });
  const r = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /^STOPPED: PageSpeed refused the key at site 1 of 4: the PSI_API_KEY secret is invalid, or restricted so that GitHub runners are blocked/);
  assert.match(r.verdict, /Replace the PSI_API_KEY Actions secret/);
  assert.deepEqual(asked, [urls[0]]);
  // Even after sites were measured: a refused key is red.
  let n = 0;
  const later = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure: async () => (n++ < 2 ? { ok: true, measured: true } : { ok: false, error: "api_key" }), pauseMs: 0, log: quiet });
  assert.equal(later.exitCode, 1);
});

test("every Lighthouse measure failing is a failed job even when the polish checks work", async () => {
  const r = await runPrewarm({ urls, base: "http://x", fetchFn: inspectOk, measure: async () => ({ ok: false, error: "unreachable" }), pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /^FAILED:/);
});

test("network errors and timeouts are counted, not thrown", async () => {
  const fetchFn = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const r = await runPrewarm({ urls: urls.slice(0, 1), base: "http://x", fetchFn, measure: measured, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1, "every polish check failed (there was only one), so the job could not do its work");
  assert.deepEqual(r.stats.inspect.errors, { timeout: 1 });
});

test("sites go several at a time, one site's lookups stay in order, and a site's due devices reach the measure", async () => {
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const fetchFn = async (u) => {
    seen.push(["inspect", decodeURIComponent(u.split("url=")[1])]);
    return json(200, { ok: true });
  };
  const measure = async ({ url, devices }) => {
    seen.push(["psi", url, devices.join("+")]);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return { ok: true, measured: true };
  };
  const sites = [{ url: urls[0], devices: ["mobile", "desktop"] }, { url: urls[1], devices: ["desktop"] }, { url: urls[2], devices: ["mobile"] }, urls[3]];
  const r = await runPrewarm({ urls: sites, base: "http://x", fetchFn, measure, pauseMs: 0, concurrency: 3, log: quiet });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stats.psi.attempted, 4);
  assert.equal(r.stats.inspect.attempted, 4);
  assert.equal(peak, 3, "three sites at once, no more");
  const devicesOf = Object.fromEntries(seen.filter((s) => s[0] === "psi").map((s) => [s[1], s[2]]));
  assert.deepEqual(devicesOf, { [urls[0]]: "mobile+desktop", [urls[1]]: "desktop", [urls[2]]: "mobile", [urls[3]]: "mobile+desktop" });
  for (const url of urls) assert.deepEqual(seen.filter((s) => s[1] === url).map((s) => s[0]), ["inspect", "psi"]);
});

test("error classes", () => {
  assert.equal(classify("unknown_url"), "not_on_roster");
  assert.equal(classify("psi_403"), "http_403");
  assert.equal(classify("http_404"), "http_404");
  assert.equal(classify("API key not valid. Please pass a valid API key."), "api_key");
  assert.equal(classify("fetch failed"), "unreachable");
  assert.equal(classify("rate_limited"), "rate_limited");
  assert.equal(classify("quota"), "quota");
});

// A tier-C site (prewarmed: Gemini's letter no longer gates Lighthouse),
// roster sites that must never be prewarmed, and sites in every Lighthouse state.
const [tierC, fresh, down, old, notPortfolio, failedGrade, oneRun, twoRuns, failedLong, noDesktop, singleDesktop, forced, failedHours, failedDesktop] = feed.slice(4, 18).map((p) => p.url);
const DAY = 86400000;
const HOUR = 3600000;

// A body PageSpeed would answer, each call with its own fetchTime (so no two runs are the same run).
let googleCalls = 0;
const lighthouseBody = () => ({
  lighthouseResult: {
    fetchTime: `2026-11-25T00:00:${String(googleCalls).padStart(2, "0")}.000Z`,
    categories: { performance: { score: 0.8 }, accessibility: { score: 0.9 }, "best-practices": { score: 0.9 }, seo: { score: 1 } },
    audits: {},
  },
});
const googleOk = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(lighthouseBody()));
};
const inspectHandler = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
};

async function runScript({ google = googleOk, inspect = inspectHandler, limit = 4, env = {}, seed = true } = {}) {
  const calls = [];
  googleCalls = 0;
  const gserver = createServer((req, res) => {
    googleCalls++;
    const q = new URL(req.url, "http://x").searchParams;
    calls.push({ url: q.get("url"), strategy: q.get("strategy"), key: q.get("key"), categories: q.getAll("category") });
    google(req, res, googleCalls);
  });
  const iserver = createServer(inspect);
  await new Promise((r) => gserver.listen(0, "127.0.0.1", r));
  await new Promise((r) => iserver.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "prewarm-"));
  const dbFile = join(dir, "db.sqlite");
  const db = createClient({ url: `file:${dbFile}` });
  await ensureRosterSchema(db);
  for (const sql of [...FRESHNESS_TABLES, ...PSI_CALL_TABLES]) await db.execute(sql);
  const add = (url, tier, extra = {}) =>
    db.execute({
      sql: "INSERT INTO portfolios (url, status, ai_rubric, health) VALUES (?, ?, ?, ?)",
      args: [url, extra.status ?? "live", JSON.stringify(extra.rubric ?? { tier }), extra.health ?? null],
    });
  if (seed) {
    for (const [i, u] of urls.entries()) await add(u, ["S", "A", "B", "A"][i]);
    await add(tierC, "C");
    await add(down, "A", { health: "down" });
    await add(notPortfolio, "D", { rubric: { tier: "D", is_portfolio: false } });
    await add(failedGrade, null, { rubric: { error: "no_usable_captures" } });
    // Gone from the roster (delisted on start), or a variant of a roster URL.
    for (const u of ["https://left-upstream.example", `${urls[0]}/`]) await add(u, "S");
    const now = Date.now();
    const good = { ok: true, runs: 2, runsAttempted: 2 };
    const failure = { ok: false, error: "timeout", runsAttempted: 2 };
    const put = (k, v, at) => db.execute({ sql: "INSERT INTO cache VALUES (?, ?, ?)", args: [k, JSON.stringify(v), at] });
    const both = async (u, phone, at, desktop = good) => {
      await add(u, "A");
      await put(`psi:${u}`, phone, at);
      if (desktop) await put(`psi-desktop:${u}`, desktop, at);
    };
    // Not due: measured a day ago with two runs a device; a phone failure 10 hours old (a failure is tried again after 20 hours).
    await both(fresh, good, now - DAY);
    await both(twoRuns, good, now - 2 * DAY);
    await both(failedHours, failure, now - 10 * HOUR);
    // Due, both devices: past 90 days.
    await both(old, good, now - 100 * DAY);
    // Due, desktop only: no desktop result; a desktop result of one run; a desktop failure older than 20 hours.
    await both(noDesktop, good, now - 5 * DAY, null);
    await both(singleDesktop, good, now - 4 * DAY, { ok: true });
    await both(failedDesktop, good, now - 6 * DAY, { ...failure, strategy: "desktop" });
    // Due, phone only: a phone result of one run (stored before two runs a device, or by a speed check); a phone failure older than 20 hours.
    await both(oneRun, { ok: true, scores: {} }, now - 3 * DAY);
    await both(failedLong, failure, now - 2 * DAY);
    // Asked for again by the admin (Re-measure) after its good result: both devices, first.
    await both(forced, good, now - 10 * DAY);
    await db.execute({ sql: "INSERT INTO site_freshness (url, forced_at) VALUES (?, ?)", args: [forced, now - DAY] });
  }
  db.close();
  const summaryFile = join(dir, "summary.md");
  const child = spawn(process.execPath, ["scripts/prewarm-metrics.mjs", `--limit=${limit}`], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${dbFile}`,
      TURSO_AUTH_TOKEN: "",
      PROD_BASE_URL: `http://127.0.0.1:${iserver.address().port}`,
      PSI_API_KEY: "test-psi-key",
      PSI_API_BASE: `http://127.0.0.1:${gserver.address().port}/runPagespeed`,
      PSI_RUN_GAP_MS: "0",
      PSI_RATE_WAITS_MS: "0,0,0",
      GITHUB_STEP_SUMMARY: summaryFile,
      PREWARM_PAUSE_MS: "0",
      // One site at a time, so the order requested is the queue's order.
      PREWARM_CONCURRENCY: "1",
      // The job never needs the app's secrets, and must not read them.
      AUTH_SECRET: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", r));
  gserver.close();
  iserver.close();
  let summary = "";
  try {
    summary = readFileSync(summaryFile, "utf8");
  } catch {
    // The job stopped before it wrote one.
  }
  const after = createClient({ url: `file:${dbFile}` });
  const rows = Object.fromEntries((await after.execute("SELECT k, v, at FROM cache")).rows.map((r) => [String(r.k), { v: JSON.parse(String(r.v) || "null"), at: Number(r.at) }]));
  const counted = Number((await after.execute({ sql: "SELECT COALESCE(SUM(n), 0) AS n FROM psi_calls WHERE day = ?", args: [quotaDay().day] })).rows[0].n);
  const attempts = (await after.execute("SELECT url, device, fails FROM psi_attempts")).rows.map((r) => ({ url: String(r.url), device: String(r.device), fails: Number(r.fails) }));
  after.close();
  return { code, summary, err, calls, rows, counted, attempts };
}

const sitesCalled = (calls) => [...new Set(calls.map((c) => c.url))];
const strategiesOf = (calls, url) => calls.filter((c) => c.url === url).map((c) => c.strategy).sort();

test("the script exits 1 and stops after the first site when PageSpeed refuses the day's quota", async () => {
  const r = await runScript({
    google: (req, res) => {
      res.statusCode = 429;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com'" } }));
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.summary, /## Prewarm metrics/);
  assert.match(r.summary, /\| psi \| 1 \| 0 \| 1 \| quota 1 \|/);
  assert.match(r.err, /::error::STOPPED: PageSpeed refused the day's quota at site 1 of 4; 3 site\(s\) not tried/);
  assert.equal(sitesCalled(r.calls).length, 1, "no site after the refusal");
  assert.equal(r.calls.length, 2, "one call a device, none retried");
  assert.equal(r.counted, 2, "the admin counter counts the calls made");
});

test("an invalid or restricted key (400 or 403 about the key) stops the job at once, red, with no failure rows and no tries noted for the sites", async () => {
  for (const [status, message] of [[400, "API key not valid. Please pass a valid API key."], [403, "Requests from this IP address are blocked. API_KEY_IP_ADDRESS_BLOCKED"]]) {
    const r = await runScript({
      google: (req, res) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: status, message } }));
      },
    });
    assert.equal(r.code, 1, `${status}: ${r.err}`);
    assert.match(r.err, /::error::STOPPED: PageSpeed refused the key at site 1 of 4: the PSI_API_KEY secret is invalid/);
    assert.equal(sitesCalled(r.calls).length, 1, "no site after the refusal");
    assert.deepEqual(r.attempts, [], "no try is noted against a site");
    for (const u of [...urls, tierC]) assert.equal(r.rows[`psi:${u}`], undefined, "no failure row is stored for a never-measured site");
    assert.equal(r.rows[`psi:${forced}`].v.runs, 2, "the first site's stored average is untouched");
  }
});

test("a per-minute refusal is waited out and retried; the job is not stopped", async () => {
  let refused = 0;
  const r = await runScript({
    google: (req, res, n) => {
      if (n <= 3) {
        refused++;
        res.statusCode = 429;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'pagespeedonline.googleapis.com'" } }));
      }
      googleOk(req, res);
    },
  });
  assert.equal(refused, 3);
  assert.equal(r.code, 0, r.err);
  assert.match(r.summary, /PageSpeed: 4 site\(s\) measured/);
  assert.equal(r.counted, r.calls.length, "every call, the refused ones too, is counted");
  assert.ok(r.calls.length > 16, "the refused calls were made again");
});

test("without PSI_API_KEY the script fails at once and says which secret to add and where", async () => {
  const r = await runScript({ env: { PSI_API_KEY: "" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /::error::PSI_API_KEY is not set/);
  assert.match(r.err, /repository Actions secret named PSI_API_KEY/);
  assert.match(r.err, /Settings > Secrets and variables > Actions/);
  assert.equal(r.calls.length, 0);
});

test("the script exits 0 when everything measures, calls PageSpeed itself with its key, and never needs an app secret", async () => {
  const r = await runScript();
  assert.equal(r.code, 0, r.err);
  assert.match(r.summary, /OK: 8 of 8 lookups succeeded/);
  assert.match(r.summary, /PageSpeed: 4 site\(s\) measured/);
  for (const c of r.calls) {
    assert.equal(c.key, "test-psi-key");
    assert.deepEqual(c.categories, ["performance", "accessibility", "best-practices", "seo"]);
  }
});

test("the script measures what is due, only the devices that are due, asked-for first, then never measured, then the oldest, and writes the rows", async () => {
  const r = await runScript({ limit: 50 });
  assert.equal(r.code, 0, r.err);
  // The admin's Re-measure first; never measured (by URL, tier C included);
  // then by age. Not: measured with two runs a device, a phone failure 10 hours
  // old, confirmed down, "not a portfolio", a failed grade, delisted, or not on the roster.
  assert.deepEqual(sitesCalled(r.calls), [forced, ...[...urls, tierC].sort(), old, failedDesktop, noDesktop, singleDesktop, oneRun, failedLong]);
  const both = ["desktop", "desktop", "mobile", "mobile"];
  for (const u of [forced, ...urls, tierC, old]) assert.deepEqual(strategiesOf(r.calls, u), both, `${u}: two runs on each device`);
  for (const u of [noDesktop, singleDesktop, failedDesktop]) assert.deepEqual(strategiesOf(r.calls, u), ["desktop", "desktop"], `${u}: desktop only, two calls`);
  for (const u of [oneRun, failedLong]) assert.deepEqual(strategiesOf(r.calls, u), ["mobile", "mobile"], `${u}: phone only, two calls`);
  assert.equal(r.counted, r.calls.length, "the admin counter equals the calls made");
  // The averages are stored under the keys the profile reads, with the run details.
  const phone = r.rows[`psi:${old}`].v;
  const desktop = r.rows[`psi-desktop:${old}`].v;
  for (const [row, strategy] of [[phone, "mobile"], [desktop, "desktop"]]) {
    assert.equal(row.ok, true);
    assert.equal(row.strategy, strategy);
    assert.equal(row.runs, 2);
    assert.equal(row.runsAttempted, 2);
    assert.deepEqual(row.runScores, [80, 80]);
    assert.equal(row.scores.performance, 80);
  }
  // A device not due is left alone; a due one is written.
  assert.equal(r.rows[`psi:${noDesktop}`].v.runs, 2);
  assert.equal(r.rows[`psi:${noDesktop}`].v.scores, undefined, "the phone row was not touched");
  assert.equal(r.rows[`psi-desktop:${noDesktop}`].v.runs, 2);
  assert.equal(r.rows[`psi-desktop:${noDesktop}`].v.scores.performance, 80);
  assert.equal(r.rows[`psi-desktop:${failedDesktop}`].v.ok, true, "a desktop failure older than 20 hours is retried");
  assert.equal(r.rows[`psi:${failedLong}`].v.ok, true);
  assert.equal(r.rows[`psi:${oneRun}`].v.runs, 2, "a phone result of one run is replaced by the average");
  // Every lease was given back.
  assert.deepEqual(Object.keys(r.rows).filter((k) => k.startsWith("lease:")), []);
});

test("a failed measure is stored as a failure only where nothing good is, and a good result is never replaced by it", async () => {
  const r = await runScript({
    limit: 50,
    google: (req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    },
  });
  // Every call fails (not a quota): all sites not measured, none stopped.
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /STOPPED/);
  assert.match(r.summary, /0 site\(s\) measured/);
  assert.equal(r.rows[`psi:${old}`].v.ok, true, "a good (old) result is never replaced by a failure");
  assert.equal(r.rows[`psi:${tierC}`].v.ok, false, "nothing stored before: the failure is stored, so a page can say why");
  assert.equal(r.rows[`psi:${tierC}`].v.error, "unreachable");
});
