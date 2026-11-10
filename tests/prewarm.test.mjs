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
import feed from "../data/feed.json" with { type: "json" };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Real roster URLs: the script only prewarms sites on data/feed.json.
const urls = feed.slice(0, 4).map((p) => p.url);
const quiet = () => {};

test("every lookup failing exits 1 and names the most common error", async () => {
  const fetchFn = async (u) =>
    u.includes("/api/psi")
      ? json(200, { ok: false, error: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" })
      : json(200, { ok: false, error: "unreachable" });
  const r = await runPrewarm({ urls, base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.match(r.verdict, /8 of 8 lookups failed; most common error: (quota|unreachable) \(4\)/);
  assert.deepEqual(r.stats.psi, { attempted: 4, ok: 0, failed: 4, errors: { quota: 4 } });
  assert.match(r.summary, /\| psi \| 4 \| 0 \| 4 \| quota 4 \|/);
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
  const half = async (u) => (u.includes("/api/psi") ? json(429, {}) : json(200, { ok: true }));
  const ok = await runPrewarm({ urls, base: "http://x", fetchFn: half, pauseMs: 0, log: quiet });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stats.psi.errors.quota, 4);
});

test("network errors and timeouts are counted, not thrown", async () => {
  const fetchFn = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const r = await runPrewarm({ urls: urls.slice(0, 1), base: "http://x", fetchFn, pauseMs: 0, log: quiet });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.stats.inspect.errors, { timeout: 1 });
});

test("error classes", () => {
  assert.equal(classify("unknown_url"), "not_on_roster");
  assert.equal(classify("psi_403"), "http_403");
  assert.equal(classify("http_404"), "http_404");
  assert.equal(classify("API key not valid. Please pass a valid API key."), "api_key");
  assert.equal(classify("fetch failed"), "unreachable");
});

// Roster sites that must never be prewarmed, and one with an old PSI result.
const [tierC, fresh, down, old] = feed.slice(4, 8).map((p) => p.url);
const DAY = 86400000;

async function runScript(handler, { limit = 4 } = {}) {
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
      args: [url, extra.status ?? "live", JSON.stringify({ tier }), extra.health ?? null],
    });
  for (const [i, u] of urls.entries()) await add(u, ["S", "A", "B", "A"][i]);
  await add(tierC, "C");
  await add(fresh, "A");
  await add(down, "A", { health: "down" });
  await add(old, "S");
  // Gone from the roster (delisted on start), or a variant of a roster URL.
  for (const u of ["https://left-upstream.example", `${urls[0]}/`]) await add(u, "S");
  const now = Date.now();
  await db.execute({ sql: "INSERT INTO cache VALUES (?, '{}', ?)", args: [`psi:${fresh}`, now - DAY] });
  await db.execute({ sql: "INSERT INTO cache VALUES (?, '{}', ?)", args: [`psi:${old}`, now - 40 * DAY] });
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

test("the script exits 1 and writes the job summary when PageSpeed has no key", async () => {
  const r = await runScript((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/api/psi") ? { ok: false, error: "Quota exceeded for quota metric 'Queries'" } : { ok: false, error: "unreachable" }));
  });
  assert.equal(r.code, 1);
  assert.match(r.summary, /## Prewarm metrics/);
  assert.match(r.summary, /\| psi \| 4 \| 0 \| 4 \| quota 4 \|/);
  assert.match(r.err, /::error::FAILED: 8 of 8 lookups failed/);
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
    res.end(JSON.stringify({ ok: true }));
  });
  assert.equal(r.code, 0);
  assert.match(r.summary, /OK: 8 of 8 lookups succeeded/);
});

test("the script picks listed S/A/B sites without a fresh PSI result, never-measured first, then the oldest", async () => {
  const r = await runScript((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }, { limit: 50 });
  assert.equal(r.code, 0);
  // Never measured (by URL), then the 40-day-old result. Not: tier C, fresh,
  // confirmed down, delisted, or not on the roster.
  assert.deepEqual(r.psi, [...[...urls].sort(), old]);
});
