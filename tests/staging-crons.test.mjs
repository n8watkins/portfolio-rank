// What staging runs on a schedule (worker/crons.ts, DEPLOY.md "Staging"):
// production runs every task, staging only its allowlist, and a task added to
// the scheduled() handler without being classified fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { CRON_GROUPS, SCHEDULED_TASKS, STAGING_TASKS, cronHasStagingTask, jobCron, taskRuns } from "../worker/crons.ts";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const all = Object.values(SCHEDULED_TASKS).flat();

/** The task names the handler uses: the [name, fn] pairs of runEach and runs("name") calls. */
function handlerTasks() {
  const src = readFileSync("worker/index.ts", "utf8");
  const body = src.slice(src.indexOf("async scheduled("));
  const names = new Set();
  for (const m of body.matchAll(/^\s*\["([^"]+)",\s*(?:async\s*)?\(/gm)) names.add(m[1]);
  for (const m of body.matchAll(/runs\("([^"]+)"\)/g)) names.add(m[1]);
  return names;
}

test("production runs every scheduled task", () => {
  for (const task of all) {
    assert.equal(taskRuns(task, "production"), true, task);
    assert.equal(taskRuns(task, undefined), true, task);
  }
  // A task the lists do not know still runs in production.
  assert.equal(taskRuns("brand new task", "production"), true);
});

test("staging runs exactly its allowlist", () => {
  assert.deepEqual(all.filter((t) => taskRuns(t, "staging")).sort(), [...STAGING_TASKS].sort());
  assert.equal(taskRuns("brand new task", "staging"), false, "an unknown task stays off on staging");
  assert.deepEqual([...STAGING_TASKS].sort(), ["edge purge", "grader", "owner removals", "people queue", "review auto-apply", "tiers"]);
});

test("the allowlist names only tasks that exist, once each", () => {
  assert.equal(new Set(all).size, all.length, "a task is in one group");
  assert.equal(new Set(STAGING_TASKS).size, STAGING_TASKS.length);
  for (const task of STAGING_TASKS) assert.ok(all.includes(task), `${task} is not a scheduled task`);
});

test("every task in the scheduled() handler is classified, and every classified task is in it", () => {
  const used = handlerTasks();
  for (const task of used) assert.ok(all.includes(task), `"${task}" runs in worker/index.ts but is not in SCHEDULED_TASKS (worker/crons.ts): decide whether staging runs it`);
  for (const task of all) assert.ok(used.has(task), `"${task}" is in SCHEDULED_TASKS but the handler does not run it`);
});

test("the handler skips a task through taskRuns, not on its own", () => {
  const src = readFileSync("worker/index.ts", "utf8");
  assert.match(src, /const runs = \(task: string\) => taskRuns\(task, env\.SITE_ENV\)/);
  assert.match(src, /only\(\[/, "the hourly and five-minute lists are filtered");
  assert.match(src, /else if \(runs\("night start"\)\) await startTonight/);
});

test("every production cron belongs to a group, and staging triggers only crons with a task left", () => {
  for (const cron of config.triggers.crons) assert.ok(CRON_GROUPS[cron], `${cron} has no group`);
  assert.deepEqual(Object.values(CRON_GROUPS).filter((g, i, a) => a.indexOf(g) === i).sort(), Object.keys(SCHEDULED_TASKS).sort());
  const triggers = config.env.staging.triggers.crons;
  for (const cron of triggers) assert.ok(cronHasStagingTask(cron), `${cron} on staging has no task to run: remove it`);
  // Every cron that has a task is there, and the nightly and weekly ones are not.
  const groups = triggers.map((c) => CRON_GROUPS[jobCron(c)]).sort();
  assert.deepEqual(groups, ["five-minute", "hourly"]);
  for (const cron of config.triggers.crons) {
    if (cronHasStagingTask(cron)) assert.ok(triggers.some((t) => jobCron(t) === cron), `${cron} has staging tasks but no staging trigger`);
  }
});
