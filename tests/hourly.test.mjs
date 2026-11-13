// The hourly cron's tasks (pipeline/hourly.mjs, worker/index.ts): one that
// throws is reported and logged, and the tasks after it still run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runEach } from "../pipeline/hourly.mjs";

test("a failing task is reported and the rest still run, in order", async () => {
  const ran = [];
  const reported = [];
  const lines = [];
  const out = await runEach(
    [
      ["first", () => ran.push("first")],
      ["broken", async () => {
        ran.push("broken");
        throw new Error("Turso said no");
      }],
      ["also broken", () => {
        throw new Error("sync failure");
      }],
      ["last", async () => ran.push("last")],
    ],
    { report: (e, name) => reported.push([name, e.message]), log: (line) => lines.push(line) }
  );
  assert.deepEqual(ran, ["first", "broken", "last"]);
  assert.deepEqual(out.failed, ["broken", "also broken"]);
  assert.deepEqual(reported, [["broken", "Turso said no"], ["also broken", "sync failure"]]);
  assert.deepEqual(lines.map((l) => [l.event, l.task]), [["hourly.task_failed", "broken"], ["hourly.task_failed", "also broken"]]);
});

test("a reporter that throws doesn't stop the next task", async () => {
  const ran = [];
  const out = await runEach(
    [
      ["a", () => {
        throw new Error("x");
      }],
      ["b", () => ran.push("b")],
    ],
    { report: () => {
      throw new Error("Sentry is down");
    } }
  );
  assert.deepEqual(ran, ["b"]);
  assert.deepEqual(out.failed, ["a"]);
});

test("worker/index.ts runs every hourly task through runEach", () => {
  const src = readFileSync("worker/index.ts", "utf8");
  const hourly = src.slice(src.indexOf("cron === PEOPLE_QUEUE_CRON"), src.indexOf("cron === MODEL_WATCH_CRON"));
  assert.match(hourly, /runEach\(/);
  for (const task of ["removalsTick", "purgeAfterHour", "emailAlertsTick", "nightWatchTick", "drainPeople", "libraryTick"]) {
    assert.match(hourly, new RegExp(`\\(\\) => \\{?\\s*(removed = \\(await )?${task}\\(`), `${task} runs inside its own task`);
  }
});
