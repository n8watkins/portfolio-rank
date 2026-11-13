// The free-limits view's data (lib/admin/limits.mjs): levels against the
// warning and danger lines, a month's pace, stale snapshots, the snapshot
// table, the live counters and the parser for `turso plan show`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { LIMITS, adminLimits, levelOf, limitRows, liveUsage, monthElapsed, parsePlanShow, readSnapshots, saveSnapshots } from "../lib/admin/limits.mjs";
import { ensureGeminiLog } from "../pipeline/gemini-log.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limits-"));
  return createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
}
const row = (rows, key) => rows.find((r) => r.key === key);

test("levels: amber at the warning line, red at the danger line", () => {
  assert.equal(levelOf(0.49), "ok");
  assert.equal(levelOf(0.5), "warn");
  assert.equal(levelOf(0.79), "warn");
  assert.equal(levelOf(0.8), "danger");
  // A limit that fills on purpose (Gemini) is fine until it is full.
  assert.equal(levelOf(0.98, 1), "ok");
  assert.equal(levelOf(1, 1), "danger");
});

test("every limit has a cap, a unit, a period and a source", () => {
  for (const l of LIMITS) {
    assert.ok(l.cap > 0, l.key);
    assert.ok(["month", "day", "total"].includes(l.period), l.key);
    assert.ok(["live", "snapshot"].includes(l.source), l.key);
    assert.ok(l.over, l.key);
  }
});

test("rows: unmeasured, measured, a month on pace past its limit, and a stale snapshot", () => {
  const now = new Date("2026-11-13T06:00:00Z");
  const at = "2026-11-13T05:00:00Z";
  const rows = limitRows({
    now,
    live: { gemini: { used: 488, at } },
    snapshots: {
      "workers.cpu": { used: 14.3e6, at },
      "turso.read": { used: 7e6, at },
      "r2.storage": { used: 3.97e9, at: "2026-11-10T00:00:00Z" },
    },
  });
  assert.equal(row(rows, "turso.write").used, null);
  assert.equal(row(rows, "turso.write").level, "unknown");
  assert.equal(row(rows, "gemini").level, "ok");
  // 48% used 40% into the month: on pace for about 119%, so it is red before it gets there.
  const cpu = row(rows, "workers.cpu");
  assert.equal(cpu.shareLevel, "ok");
  assert.ok(cpu.pace > 1.1 && cpu.pace < 1.25, String(cpu.pace));
  assert.equal(cpu.level, "danger");
  assert.equal(row(rows, "turso.read").level, "ok");
  assert.equal(row(rows, "r2.storage").stale, true);
  assert.equal(row(rows, "turso.read").stale, false);
  // Projections at the three library sizes.
  assert.deepEqual(row(rows, "turso.write").projections.map((p) => p.size), [5000, 20000, 50000]);
  assert.ok(Math.abs(monthElapsed("2026-11-16T00:00:00Z") - 0.5) < 1e-9);
});

test("snapshots: stored per key, replaced by the next measurement", async () => {
  const db = tempDb();
  assert.deepEqual(await readSnapshots(db), {});
  await saveSnapshots(db, { "turso.read": { used: 1, detail: { via: "a" } }, "r2.storage": { used: 2 }, bad: { used: "x" } }, "2026-11-12T00:00:00Z");
  await saveSnapshots(db, { "turso.read": { used: 3 } }, "2026-11-13T00:00:00Z");
  const s = await readSnapshots(db);
  assert.deepEqual(Object.keys(s).sort(), ["r2.storage", "turso.read"]);
  assert.equal(s["turso.read"].used, 3);
  assert.equal(s["turso.read"].at, "2026-11-13T00:00:00Z");
  assert.equal(s["r2.storage"].used, 2);
});

test("live usage: today's counts from the app's own tables, nothing before they exist", async () => {
  const db = tempDb();
  assert.deepEqual(await liveUsage(db), {});
  await migrate(db);
  await ensureGeminiLog(db);
  const now = new Date();
  await db.batch([
    { sql: "INSERT INTO gemini_requests (at, model, status) VALUES (?, 'gemini-3.5-flash-lite', 200)", args: [now.toISOString()] },
    { sql: "INSERT INTO gemini_requests (at, model, status) VALUES (?, 'gemini-3.5-flash-lite', 200)", args: ["2020-01-01T00:00:00Z"] },
    { sql: "INSERT INTO cache (k, v, at) VALUES ('psi:https://a.example', '{}', ?)", args: [now.getTime()] },
    { sql: "INSERT INTO cache (k, v, at) VALUES ('psi-desktop:https://a.example', '{}', ?)", args: [now.getTime()] },
    { sql: "INSERT INTO cache (k, v, at) VALUES ('psi:https://b.example', '{}', ?)", args: [0] },
    { sql: "INSERT INTO cache (k, v, at) VALUES ('inspect:https://a.example', '{}', ?)", args: [now.getTime()] },
  ]);
  const live = await liveUsage(db, { now });
  assert.equal(live.gemini.used, 1);
  assert.equal(live.psi.used, 2);
  const all = await adminLimits(db, { now, env: { TAVILY_MONTHLY_CREDITS: "150" } });
  assert.equal(row(all.rows, "tavily").cap, 150);
  assert.equal(all.snapshotAt, null);
});

test("turso plan show is read into rows read, rows written and storage", () => {
  const out = `Organization: personal
Plan: starter
Overages disabled

RESOURCE        USED   LIMIT   LIMIT %
storage         31 MB  5.0 GB  1%
rows read       6.8M   500M    1%
rows written    0.2M   10M     2%
embedded syncs  0 B    3.0 GB  0%
`;
  assert.deepEqual(parsePlanShow(out), { rowsRead: 6.8e6, rowsWritten: 0.2e6, storage: 31e6 });
});
