// What runs on a schedule (worker/crons.ts): every task the scheduled()
// handler runs is listed, every listed task is run, and every cron in
// wrangler.jsonc belongs to a group.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { CRON_GROUPS, SCHEDULED_TASKS } from "../worker/crons.ts";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const all = Object.values(SCHEDULED_TASKS).flat();
const handler = () => {
  const src = readFileSync("worker/index.ts", "utf8");
  return src.slice(src.indexOf("async scheduled("));
};

/** The task names the handler gives runEach: its [name, fn] pairs. */
function runEachTasks() {
  const names = new Set();
  for (const m of handler().matchAll(/^\s*\["([^"]+)",\s*(?:async\s*)?\(/gm)) names.add(m[1]);
  return names;
}

test("the task names are unique", () => {
  assert.equal(new Set(all).size, all.length);
});

test("every task the handler runs is listed, and every listed task is run", () => {
  const used = runEachTasks();
  for (const task of used) assert.ok(all.includes(task), `"${task}" runs in worker/index.ts but is not in SCHEDULED_TASKS (worker/crons.ts)`);
  // The hourly and five-minute groups run through runEach; the nightly and weekly ones call their task directly.
  for (const task of [...SCHEDULED_TASKS.hourly, ...SCHEDULED_TASKS["five-minute"]]) assert.ok(used.has(task), `"${task}" is in SCHEDULED_TASKS but the handler does not run it`);
  const src = handler();
  assert.match(src, /await startTonight\(/, "night start");
  assert.match(src, /await goalsTick\(/, "goals");
  assert.match(src, /await watchModels\(/, "model watch");
});

test("every cron belongs to a group, and every group has a cron", () => {
  for (const cron of config.triggers.crons) assert.ok(CRON_GROUPS[cron], `${cron} has no group`);
  for (const cron of Object.keys(CRON_GROUPS)) assert.ok(config.triggers.crons.includes(cron), `${cron} is not a trigger in wrangler.jsonc`);
  assert.deepEqual(Object.values(CRON_GROUPS).filter((g, i, a) => a.indexOf(g) === i).sort(), Object.keys(SCHEDULED_TASKS).sort());
});
