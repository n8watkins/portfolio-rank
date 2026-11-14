// The admin quota view's API (GET /api/admin/quota), end to end against the
// running production build (scripts/test-e2e.sh, which sets
// ADMIN_GITHUB_ID): only that GitHub account may read it, and it
// reports Gemini use by Pacific quota day, job and model, and the weekly
// model watch's latest report.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { quotaDay } from "../pipeline/budget.mjs";
import { buildReport, ensureModelWatchSchema } from "../pipeline/model-watch.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

const cookieFor = (login, id) => sessionCookie({ id, login });

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

test("admin quota API: the admin is the account id, not the login", async () => {
  // Someone who registered the admin's login after a rename: another account.
  const squatter = await get(await cookieFor("e2e-admin", ADMIN_ID + 1));
  assert.equal(squatter.status, 403);
  // The admin after renaming their GitHub account: the same id.
  const renamed = await get(await cookieFor("renamed-admin", ADMIN_ID));
  assert.equal(renamed.status, 200);
});

test("admin quota API: today's and the last 30 days' use by job and model, the allowances and the runs", async () => {
  await ensureGeminiLog(db);
  const now = new Date();
  const today = quotaDay(now);
  const people = createRequestLog({ db, job: "people-grade", runId: "e2e" });
  const night = createRequestLog({ db, job: "compare", runId: "e2e" });
  for (let i = 0; i < 3; i++) await people.record({ at: new Date(today.start.getTime() + 60000).toISOString(), model: PRIMARY_MODEL, status: 200 });
  await night.record({ at: new Date(today.start.getTime() - 3600000).toISOString(), model: PRIMARY_MODEL, status: 503 }); // yesterday

  const res = await get(await cookieFor("e2e-admin", ADMIN_ID));
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
    ["Grade new sites", "Grade changed sites", "AI ranking comparisons", "Content", "Image library", "Re-grades (3.1 and older rubric)", "Experiments"]
  );
  assert.equal(typeof body.now.people, "number");
  assert.ok(Array.isArray(body.nights) && Array.isArray(body.parked) && Array.isArray(body.alerts));
  assert.equal(typeof body.peopleQueue, "object");
  // Tavily credits this month against the cap (200 by default; the e2e run sets none).
  assert.match(body.tavily.month, /^\d{4}-\d{2}$/);
  assert.equal(typeof body.tavily.used, "number");
  assert.equal(body.tavily.cap, 200);
  // Pexels searches this month (500 by default) and today's AI images, "N of 40", with their neurons.
  assert.match(body.pexels.month, /^\d{4}-\d{2}$/);
  assert.equal(typeof body.pexels.used, "number");
  assert.equal(body.pexels.cap, 500);
  assert.match(body.aiImages.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([body.aiImages.images, body.aiImages.maxImages, body.aiImages.ceiling, body.aiImages.slice, body.aiImages.free], [0, 40, 2500, 5000, 10000]);
  assert.equal(body.aiImages.problem, null);
  assert.equal(body.library.subjects, 130);
  // When checks re-run (lib/freshness.mjs): the counts are numbers, even on a database with no checks yet.
  for (const k of ["unchanged", "changedThisWeek", "unchecked", "checkedToday"]) assert.equal(typeof body.freshness[k], "number", k);
  assert.equal(typeof body.freshness.remeasuredToday.total, "number");
});

test("admin quota API: the latest model watch report, recorded even while email is off", async () => {
  await ensureModelWatchSchema(db);
  const sources = { models: { ok: true, data: {} }, deprecations: { ok: true, data: {} }, changelog: { ok: false, error: "HTTP 503" } };
  const report = buildReport(sources, null, { now: new Date("2026-11-16T16:00:00Z") });
  await db.execute({
    sql: "INSERT INTO model_watch_runs (ran_at, status, changes, snapshot, report) VALUES (?, 'partial', 0, '{}', ?)",
    args: [report.ranAt, JSON.stringify(report)],
  });
  const body = await (await get(await cookieFor("e2e-admin", ADMIN_ID))).json();
  assert.equal(body.modelWatch.runs[0].status, "partial");
  assert.equal(body.modelWatch.latest.ranAt, "2026-11-16T16:00:00.000Z");
  assert.match(body.modelWatch.latest.text, /Could not read the changelog source: HTTP 503/);
});

test("admin usage page: plain-language meters for the admin, a 404 for everyone else", async () => {
  const { chromium } = await import("playwright");
  const anon = await fetch(`${BASE}/admin/usage`);
  assert.equal(anon.status, 404);
  const other = await fetch(`${BASE}/admin/usage`, { headers: { cookie: await cookieFor("someone-else", 990000001) } });
  assert.equal(other.status, 404);

  const cookie = await cookieFor("e2e-admin", ADMIN_ID);
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${BASE}/admin/usage`);
      await page.getByRole("heading", { level: 1, name: "Usage" }).waitFor();
      const gemini = page.getByRole("meter", { name: /^Gemini 3\.5 Flash-Lite today$/ });
      assert.match(await gemini.getAttribute("aria-valuetext"), /^\d[\d,]* of \d[\d,]* requests$/);
      await page.getByRole("meter", { name: "Grade new sites" }).waitFor();
      await page.getByRole("meter", { name: "AI images today" }).or(page.getByText("No AI images yet.")).first().waitFor();
      await page.getByRole("meter", { name: "Tavily credits" }).waitFor();
      await page.getByRole("heading", { name: "Grades on their way" }).waitFor();
      await page.getByText(/Site checks: \d[\d,]* unchanged, \d[\d,]* changed this week, \d[\d,]* re-measured today/).waitFor();
      await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Images" }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no sideways scroll at ${width}px`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
