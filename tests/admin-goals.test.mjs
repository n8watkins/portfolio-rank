// The owner's goals feed (GET /api/admin/goals), end to end against the
// running production build (scripts/test-e2e.sh): only the admin reads it,
// never cached, and it lists every goal with its numbers measured now and
// its recorded weeks, writing nothing.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { GOALS } from "../lib/goals/config.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const get = (cookie) => fetch(`${BASE}/api/admin/goals`, { headers: cookie ? { cookie } : {} });

test("goals feed: signed out is 401, another account is 403, never cached", async () => {
  const anon = await get();
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  assert.equal((await get(await sessionCookie({ id: ADMIN_ID + 1, login: "e2e-admin" }))).status, 403);
});

test("goals feed: every goal with its conditions measured now, its history and event, and nothing written", async () => {
  const before = Number((await db.execute("SELECT COUNT(*) AS n FROM goal_progress")).rows[0].n);
  const r = await get(await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.week, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    body.goals.map((g) => g.id),
    GOALS.map((g) => g.id)
  );
  for (const g of body.goals) {
    assert.equal(typeof g.reached, "boolean");
    assert.ok(g.conditions.length > 0);
    for (const c of g.conditions) assert.ok(c.values.every((v) => v === null || Number.isInteger(v)), JSON.stringify(c));
    assert.ok(Array.isArray(g.history));
    assert.equal(g.meeting.minutes, 30);
  }
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM goal_progress")).rows[0].n), before, "the feed is a dry run");
});
