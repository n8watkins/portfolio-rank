// The end-of-day run's dead-man check (pipeline/night-watch.mjs,
// worker/night-watch.ts): a night that never started or died partway raises
// an owner alert on the hourly cron; a paused or finished night does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { budgetPlan } from "../pipeline/budget.mjs";
import { ensureNightSchema } from "../pipeline/night.mjs";
import { reconcileAlerts } from "../pipeline/alerts.mjs";
import { expectedNight, isDuplicateInstance, isNightWatchAlert, nightWatchConditions } from "../pipeline/night-watch.mjs";

const plan = budgetPlan();

function freshDb() {
  return createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "night-watch-")), "db.sqlite")}` });
}

async function withNight(db, { night, startedAt, status, runId = `night-${night}` }) {
  await ensureNightSchema(db);
  await db.execute({ sql: "INSERT INTO night_runs (night, started_at, status, run_id) VALUES (?, ?, ?, ?)", args: [night, startedAt, status, runId] });
}

// November 2026 is Pacific standard time (UTC-8): 20:30 there is 04:30 UTC the next day.
test("the expected night is today's from an hour after the 20:30 start, else yesterday's", () => {
  assert.equal(expectedNight(new Date("2026-11-14T05:15:00Z"), plan), "2026-11-12"); // 21:15 on the 13th
  assert.equal(expectedNight(new Date("2026-11-14T05:30:00Z"), plan), "2026-11-13"); // 21:30 on the 13th
  assert.equal(expectedNight(new Date("2026-11-14T09:15:00Z"), plan), "2026-11-13"); // 01:15 on the 14th
  // Daylight time (UTC-7): 21:30 on July 1 is 04:30 UTC on July 2.
  assert.equal(expectedNight(new Date("2026-07-02T04:15:00Z"), plan), "2026-06-30");
  assert.equal(expectedNight(new Date("2026-07-02T04:30:00Z"), plan), "2026-07-01");
});

test("a night with no row an hour after its start is missed", async () => {
  const db = freshDb();
  await ensureNightSchema(db);
  const c = await nightWatchConditions(db, { now: new Date("2026-11-14T06:15:00Z"), plan });
  assert.deepEqual(c.map((x) => x.key), ["night-watch:missed"]);
  assert.match(c[0].detail, /2026-11-13/);
});

test("a database where no night has ever run (no table) is missed too", async () => {
  const c = await nightWatchConditions(freshDb(), { now: new Date("2026-11-14T06:15:00Z"), plan });
  assert.deepEqual(c.map((x) => x.key), ["night-watch:missed"]);
});

test("before the grace has passed, yesterday's finished night is all that counts", async () => {
  const db = freshDb();
  await withNight(db, { night: "2026-11-12", startedAt: "2026-11-13T04:30:00Z", status: "complete" });
  assert.deepEqual(await nightWatchConditions(db, { now: new Date("2026-11-14T05:15:00Z"), plan }), []);
});

test("a finished or stopped night raises nothing", async () => {
  for (const status of ["complete", "stopped"]) {
    const db = freshDb();
    await withNight(db, { night: "2026-11-13", startedAt: "2026-11-14T04:30:00Z", status });
    assert.deepEqual(await nightWatchConditions(db, { now: new Date("2026-11-14T09:15:00Z"), plan }), []);
  }
});

test("a running night is fine until an hour after its hard stop, then stuck unless the owner paused it", async () => {
  const db = freshDb();
  await withNight(db, { night: "2026-11-13", startedAt: "2026-11-14T04:30:00Z", status: "running" });
  const asked = [];
  const instanceStatus = (status) => async (id) => {
    asked.push(id);
    return status;
  };
  // Hard stop 23:30 Pacific (07:30 UTC), plus the hour: 08:30 UTC.
  assert.deepEqual(await nightWatchConditions(db, { now: new Date("2026-11-14T08:15:00Z"), plan, instanceStatus: instanceStatus("errored") }), []);
  assert.deepEqual(asked, [], "the instance is only asked about once the run is overdue");

  const stuck = await nightWatchConditions(db, { now: new Date("2026-11-14T09:15:00Z"), plan, instanceStatus: instanceStatus("errored") });
  assert.deepEqual(stuck.map((x) => x.key), ["night-watch:stuck"]);
  assert.match(stuck[0].detail, /night-2026-11-13: errored/);
  assert.deepEqual(asked, ["night-2026-11-13"]);

  for (const paused of ["paused", "waitingForPause"]) {
    assert.deepEqual(await nightWatchConditions(db, { now: new Date("2026-11-14T09:15:00Z"), plan, instanceStatus: instanceStatus(paused) }), []);
  }
  // A status lookup that fails still alerts: the row alone says the run never finished.
  const unknown = await nightWatchConditions(db, {
    now: new Date("2026-11-14T09:15:00Z"),
    plan,
    instanceStatus: async () => {
      throw new Error("instance.not_found");
    },
  });
  assert.match(unknown[0].detail, /status unknown/);
});

test("an older run left running does not alert once a later night is due", async () => {
  // The owner's paused night-2026-11-12 stays "running"; the 13th's finished.
  const db = freshDb();
  await withNight(db, { night: "2026-11-12", startedAt: "2026-11-13T04:30:00Z", status: "running" });
  await withNight(db, { night: "2026-11-13", startedAt: "2026-11-14T04:30:00Z", status: "complete" });
  assert.deepEqual(await nightWatchConditions(db, { now: new Date("2026-11-14T09:15:00Z"), plan, instanceStatus: async () => "errored" }), []);
});

test("only the duplicate-id error counts as tonight already existing", () => {
  assert.equal(isDuplicateInstance(new Error('Workflow instance with id "night-2026-11-13" already exists')), true);
  assert.equal(isDuplicateInstance(new Error("workflows.api.error.instance.already_exists")), true);
  assert.equal(isDuplicateInstance(new Error("Network connection lost.")), false);
  assert.equal(isDuplicateInstance(new Error("Cannot read properties of undefined (reading 'create')")), false);
});

test("the dead-man alert emails once a day, and only the watch's own scope clears it", async () => {
  const db = freshDb();
  await ensureNightSchema(db);
  const sent = [];
  const email = { send: async (m) => void sent.push(m) };
  const tick = async (at) =>
    reconcileAlerts(db, { conditions: await nightWatchConditions(db, { now: new Date(at), plan }), scope: isNightWatchAlert, now: new Date(at), email, to: "owner@example.com" });

  let r = await tick("2026-11-14T06:15:00Z");
  assert.deepEqual(r.sent, ["night-watch:missed"]);
  r = await tick("2026-11-14T07:15:00Z");
  assert.deepEqual(r.sent, [], "one email per condition per day");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\[PortfolioRank\] The end-of-day run didn't start/);

  // The night's own reconcile (worker/night.ts) leaves the watch's alert alone.
  r = await reconcileAlerts(db, { conditions: [], scope: (key) => !isNightWatchAlert(key), now: new Date("2026-11-14T07:20:00Z") });
  assert.deepEqual(r.cleared, []);

  // The night shows up late and finishes: the next tick clears the alert.
  await db.execute({ sql: "INSERT INTO night_runs (night, started_at, finished_at, status, run_id) VALUES ('2026-11-13', '2026-11-14T07:30:00Z', '2026-11-14T07:50:00Z', 'complete', 'manual')" });
  r = await tick("2026-11-14T08:15:00Z");
  assert.deepEqual(r.cleared, ["night-watch:missed"]);
});
