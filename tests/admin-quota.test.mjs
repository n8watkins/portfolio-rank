// The admin quota view's API (GET /api/admin/quota), end to end against the
// running production build (scripts/test-e2e.sh, which sets
// ADMIN_GITHUB_LOGIN=e2e-admin): only that GitHub login may read it, and it
// reports Gemini use by Pacific quota day, job and model, and the weekly
// model watch's latest report.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { quotaDay } from "../pipeline/budget.mjs";
import { buildReport, ensureModelWatchSchema } from "../pipeline/model-watch.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

async function cookieFor(login, id) {
  const token = await encode({
    token: { raterId: `gh:${id}`, login, sub: String(id) },
    secret: process.env.AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 3600,
  });
  return `authjs.session-token=${token}`;
}

before(async () => {
  // Wait for the server (the runner starts it just before the tests).
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const get = (cookie) => fetch(`${BASE}/api/admin/quota`, { headers: cookie ? { cookie } : {} });

test("admin quota API: signed out is 401, any other login is 403, never cached", async () => {
  const anon = await get();
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  const other = await get(await cookieFor("someone-else", 990000001));
  assert.equal(other.status, 403);
  assert.deepEqual(await other.json(), { error: "forbidden" });
});

test("admin quota API: today's and the last 30 days' use by job and model, the allowances and the runs", async () => {
  await ensureGeminiLog(db);
  const now = new Date();
  const today = quotaDay(now);
  const people = createRequestLog({ db, job: "people-grade", runId: "e2e" });
  const night = createRequestLog({ db, job: "compare", runId: "e2e" });
  for (let i = 0; i < 3; i++) await people.record({ at: new Date(today.start.getTime() + 60000).toISOString(), model: PRIMARY_MODEL, status: 200 });
  await night.record({ at: new Date(today.start.getTime() - 3600000).toISOString(), model: PRIMARY_MODEL, status: 503 }); // yesterday

  const res = await get(await cookieFor("E2E-Admin", 990000002)); // logins match case-insensitively
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, "America/Los_Angeles");
  assert.equal(body.days.length, 30);
  assert.equal(body.today.day, today.day);
  const peopleToday = body.today.jobs.find((j) => j.job === "people-grade");
  assert.equal(peopleToday.label, "Grade my portfolio (people)");
  assert.ok(peopleToday.requests >= 3);
  const yesterday = body.days[1].jobs.find((j) => j.job === "compare");
  assert.equal(yesterday.label, "AI ranking comparisons");
  assert.ok(yesterday.requests >= 1 && yesterday.ok === 0);
  assert.deepEqual(
    body.now.background.map((s) => s.label),
    ["Grade new sites", "Grade changed sites", "AI ranking comparisons", "Content", "Re-grades (3.1 and older rubric)", "Experiments"]
  );
  assert.equal(typeof body.now.people, "number");
  assert.ok(Array.isArray(body.nights) && Array.isArray(body.parked) && Array.isArray(body.alerts));
  assert.equal(typeof body.peopleQueue, "object");
});

test("admin quota API: the latest model watch report, recorded even while email is off", async () => {
  await ensureModelWatchSchema(db);
  const sources = { models: { ok: true, data: {} }, deprecations: { ok: true, data: {} }, changelog: { ok: false, error: "HTTP 503" } };
  const report = buildReport(sources, null, { now: new Date("2026-11-16T16:00:00Z") });
  await db.execute({
    sql: "INSERT INTO model_watch_runs (ran_at, status, changes, snapshot, report) VALUES (?, 'partial', 0, '{}', ?)",
    args: [report.ranAt, JSON.stringify(report)],
  });
  const body = await (await get(await cookieFor("e2e-admin", 990000002))).json();
  assert.equal(body.modelWatch.runs[0].status, "partial");
  assert.equal(body.modelWatch.latest.ranAt, "2026-11-16T16:00:00.000Z");
  assert.match(body.modelWatch.latest.text, /Could not read the changelog source: HTTP 503/);
});
