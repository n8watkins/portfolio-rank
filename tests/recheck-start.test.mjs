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

test("a refused dispatch reaches the hourly report callback, and is not retried", async () => {
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
  assert.equal(attempts, 1);
  assert.deepEqual(reported, [["recheck start", "starting recheck.yml on GitHub failed: HTTP 403 "]]);
});

test("a missing token raises the dispatch-token alert and starts nothing; an expiring one too", async () => {
  const alerts = [];
  const alert = async (conditions) => alerts.push(conditions.map((c) => c.key));
  const missing = await recheckStartTick({}, AT, { db: dbWith(2), alert, dispatch: async () => ({ skipped: "GITHUB_DISPATCH_TOKEN is not set: skipped" }) });
  assert.equal(missing.started, false);
  assert.deepEqual(alerts, [["dispatch-token:missing"]]);
  const soon = new Date(AT + 3 * 86400000).toISOString();
  const expiring = await recheckStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, AT, { db: dbWith(2), alert, dispatch: async () => ({ runId: 1, url: null, tokenExpires: soon }) });
  assert.equal(expiring.started, true);
  assert.deepEqual(alerts[1], ["dispatch-token:expiring"]);
});

test("a count that cannot be read throws, so it is reported and tried again next hour", async () => {
  await assert.rejects(recheckStartTick({}, AT, { db: { execute: async () => { throw new Error("no such column"); } } }), /no such column/);
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
