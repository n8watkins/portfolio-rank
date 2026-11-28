// The Worker's hourly task that starts prewarm.yml (worker/prewarm-start.ts):
// only in the 09 UTC hour, one dispatch (retried once), nothing without the
// token, and the workflow's GitHub schedule is a guarded fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prewarmStartTick } from "../worker/prewarm-start.ts";
import { runEach } from "../pipeline/hourly.mjs";
import { SCHEDULED_TASKS } from "../worker/crons.ts";

const at = (h) => Date.parse(`2026-11-28T${String(h).padStart(2, "0")}:15:00Z`);
const ok = (calls) => async (o) => (calls.push(o), { runId: 5, url: "u", tokenExpires: null });

test("dispatches prewarm.yml at 09:15 UTC, with no inputs (the workflow's defaults apply)", async () => {
  const calls = [];
  const out = await prewarmStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, at(9), { dispatch: ok(calls) });
  assert.deepEqual(out, { started: true, runId: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workflow, "prewarm.yml");
  assert.equal(calls[0].token, "t");
  assert.equal(calls[0].inputs, undefined);
});

test("dispatches in no other hour of the day", async () => {
  const calls = [];
  for (let h = 0; h < 24; h++) {
    const out = await prewarmStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, at(h), { dispatch: ok(calls) });
    assert.equal(out.started, h === 9, `hour ${h}`);
  }
  assert.equal(calls.length, 1, "once a day");
});

test("a dispatch refused once is tried once more and starts", async () => {
  let attempts = 0;
  const flaky = async () => {
    if (++attempts === 1) throw new Error("starting prewarm.yml on GitHub failed: HTTP 502 ");
    return { runId: 9, url: "u", tokenExpires: null };
  };
  assert.deepEqual(await prewarmStartTick({ GITHUB_DISPATCH_TOKEN: "t" }, at(9), { dispatch: flaky }), { started: true, runId: 9 });
  assert.equal(attempts, 2);
});

test("a dispatch refused twice is reported and not tried again by the later ticks (the GitHub schedule is the fallback)", async () => {
  let attempts = 0;
  const reported = [];
  const refuse = async () => {
    attempts++;
    throw new Error("starting prewarm.yml on GitHub failed: HTTP 403 ");
  };
  const env = { GITHUB_DISPATCH_TOKEN: "t" };
  await runEach([["prewarm start", () => prewarmStartTick(env, at(9), { dispatch: refuse })]], {
    report: (e, task) => reported.push([task, e.message]),
    log: () => {},
  });
  assert.equal(attempts, 2);
  assert.deepEqual(reported, [["prewarm start", "starting prewarm.yml on GitHub failed: HTTP 403 "]]);
  for (const h of [10, 11, 12, 13]) await prewarmStartTick(env, at(h), { dispatch: refuse });
  assert.equal(attempts, 2, "no later tick tries again");
});

test("a missing token starts nothing and does not throw", async () => {
  const out = await prewarmStartTick({}, at(9), { dispatch: async () => ({ skipped: "GITHUB_DISPATCH_TOKEN is not set: skipped" }) });
  assert.deepEqual(out, { started: false, skipped: "GITHUB_DISPATCH_TOKEN is not set: skipped" });
});

test("without a token the real dispatcher makes no request", async () => {
  const out = await prewarmStartTick({}, at(9));
  assert.equal(out.started, false);
  assert.match(out.skipped, /GITHUB_DISPATCH_TOKEN is not set/);
});

test("in the hourly group, wired in the handler", () => {
  assert.ok(SCHEDULED_TASKS.hourly.includes("prewarm start"));
  assert.match(readFileSync("worker/index.ts", "utf8"), /\["prewarm start", \(\) => prewarmStartTick\(env as NightEnv, at\)\]/);
});

test("prewarm.yml: manual inputs keep sane defaults for a dispatch with none", () => {
  const y = readFileSync(".github/workflows/prewarm.yml", "utf8");
  assert.match(y, /limit:\n(?:.*\n)*?\s+default: "400"/);
  assert.match(y, /LIMIT: \$\{\{ github\.event\.inputs\.limit \|\| '400' \}\}/);
  assert.match(y, /code: \$\{\{ inputs\.code \}\}/);
});

test("prewarm.yml: schedule guarded by a run already dispatched that UTC day, own concurrency group", () => {
  const y = readFileSync(".github/workflows/prewarm.yml", "utf8");
  assert.match(y, /concurrency:\n  group: prewarm\n  cancel-in-progress: false/);
  assert.match(y, /fallback-guard:/);
  assert.match(y, /WORKFLOW: prewarm\.yml/);
  assert.match(y, /since=\$\(date -u \+%Y-%m-%dT00:00:00Z\)/);
  assert.match(y, /event=workflow_dispatch&created=%3E%3D\$since/);
  assert.match(y, /select\(\.status != "completed" or \.conclusion == "success"\)/);
  assert.match(y, /\| length'\) \|\| n=0/);
  assert.match(y, /prewarm:\n    needs: fallback-guard\n    if: needs\.fallback-guard\.outputs\.run == 'true'/);
});
