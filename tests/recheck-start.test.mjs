// The Worker's hourly task that starts recheck.yml (worker/recheck-start.ts):
// dispatches only when a site is due, reports a failed dispatch, and the
// workflow's GitHub schedule is a guarded fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recheckStartTick } from "../worker/recheck-start.ts";
import { runEach } from "../pipeline/hourly.mjs";
import { DUE_COUNT_SQL } from "../pipeline/not-working.mjs";
import { STAGING_TASKS, SCHEDULED_TASKS } from "../worker/crons.ts";

const AT = Date.parse("2026-11-18T18:15:00Z");
const dbWith = (n, seen = []) => ({
  execute: async (q) => {
    seen.push(q);
    return { rows: [{ n }] };
  },
});

test("dispatches recheck.yml when one site is due", async () => {
  const seen = [];
  const calls = [];
  const out = await recheckStartTick(
    { GITHUB_DISPATCH_TOKEN: "t" },
    AT,
    { db: dbWith(1, seen), dispatch: async (o) => (calls.push(o), { runId: 7, url: "u", tokenExpires: null }) }
  );
  assert.deepEqual(out, { due: 1, started: true, runId: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, "recheck.yml");
  assert.equal(calls[0].token, "t");
  assert.equal(seen.length, 1, "one query");
  assert.equal(seen[0].sql, DUE_COUNT_SQL);
});

test("does not dispatch when nothing is due", async () => {
  let dispatched = 0;
  const out = await recheckStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, AT, { db: dbWith(0), dispatch: async () => void dispatched++ });
  assert.deepEqual(out, { due: 0, started: false });
  assert.equal(dispatched, 0);
});

test("a dispatch refused once is tried once more and starts", async () => {
  let attempts = 0;
  const flaky = async () => {
    if (++attempts === 1) throw new Error("starting recheck.yml on GitHub failed: HTTP 502 ");
    return { runId: 9, url: "u", tokenExpires: null };
  };
  const out = await recheckStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, AT, { db: dbWith(1), dispatch: flaky });
  assert.deepEqual(out, { due: 1, started: true, runId: 9 });
  assert.equal(attempts, 2);
});

test("a dispatch refused twice reaches the hourly report callback", async () => {
  let attempts = 0;
  const reported = [];
  const refuse = async () => {
    attempts++;
    throw new Error("starting recheck.yml on GitHub failed: HTTP 403 ");
  };
  await runEach([["recheck start", () => recheckStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, AT, { db: dbWith(3), dispatch: refuse })]], {
    report: (e, task) => reported.push([task, e.message]),
    log: () => {},
  });
  assert.equal(attempts, 2);
  assert.deepEqual(reported, [["recheck start", "starting recheck.yml on GitHub failed: HTTP 403 "]]);
});

test("a missing token starts nothing and does not throw (the GitHub schedule is the fallback)", async () => {
  const missing = await recheckStartTick({}, AT, { db: dbWith(2), dispatch: async () => ({ skipped: "GITHUB_DISPATCH_TOKEN is not set: skipped" }) });
  assert.deepEqual(missing, { due: 2, started: false, skipped: "GITHUB_DISPATCH_TOKEN is not set: skipped" });
});

test("a count that cannot be read still starts the workflow, then throws so it is reported", async () => {
  let dispatched = 0;
  const db = { execute: async () => { throw new Error("no such column"); } };
  await assert.rejects(recheckStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, AT, { db, dispatch: async () => (dispatched++, { runId: 1, url: null, tokenExpires: null }) }), /no such column/);
  assert.equal(dispatched, 1);
});

test("the first hourly task, so a slow task cannot delay it", () => {
  assert.equal(SCHEDULED_TASKS.hourly[0], "recheck start");
  assert.match(readFileSync("worker/index.ts", "utf8"), /only\(\[\n(\s*\/\/.*\n)*\s*\["recheck start"/);
});

test("the fallback guard runs the count when GitHub will not list the runs", () => {
  assert.match(readFileSync(".github/workflows/recheck.yml", "utf8"), /\| length'\) \|\| n=0/);
});

test("production-only: in the hourly group, never in the staging allowlist", () => {
  assert.ok(SCHEDULED_TASKS.hourly.includes("recheck start"));
  assert.ok(!STAGING_TASKS.includes("recheck start"));
});

test("recheck.yml: manual dispatch kept, schedule guarded like health.yml, own concurrency group", () => {
  const y = readFileSync(".github/workflows/recheck.yml", "utf8");
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /concurrency:\n  group: recheck\n  cancel-in-progress: false/);
  assert.match(y, /WORKFLOW: recheck\.yml/);
  assert.match(y, /event=workflow_dispatch&created=%3E%3D\$since/);
  assert.match(y, /select\(\.status != "completed" or \.conclusion == "success"\)/);
  assert.match(y, /due:\n    needs: fallback-guard\n    if: needs\.fallback-guard\.outputs\.run == 'true'/);
});
