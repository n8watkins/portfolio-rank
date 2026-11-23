// The admin's Capture problems page (/admin/capture-problems,
// lib/capture-problems.mjs) end to end against the running production build
// (scripts/test-e2e.sh): only the admin gets it and its API; it shows the
// four groups with their counts and a seeded row in each, with the reason in
// plain words, the grade, the health state and the review state; the
// phone-view-only bot check says it was kept off the review list; a change
// that came with new measuring code is listed apart and not counted; the
// phone width has no sideways scroll.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const A = "https://e2e-cp-refresh-phone-only-with-a-very-long-address-that-must-wrap.dev";
const A2 = "https://e2e-cp-refresh-bot-check.dev";
const U = "https://e2e-cp-unmeasured.dev";
const B = "https://e2e-cp-first-capture.dev";
const C = "https://e2e-cp-stored-wall.dev";
const D = "https://e2e-cp-worse.dev";
const M = "https://e2e-cp-measuring.dev";
const TEXT = "Jane Doe, backend engineer. I build payment systems and developer tools. ".repeat(10);

let cookie;
let db;

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  cookie = await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
  // The admin API makes sure the schema is there.
  assert.equal((await fetch(`${BASE}/api/admin/capture-problems`, { headers: { cookie } })).status, 200);
  db = createClient({ url: DB_URL, timeout: 10000 });
  const add = (url, cols) => {
    const row = { name: "", status: "live", reason: "", shot_key: "e2ecp00000000000", captured_at: "2026-11-20 03:00:00", page_text: TEXT, facts: '{"v":2}', ...cols };
    const keys = Object.keys(row);
    return db.execute({ sql: `INSERT OR REPLACE INTO portfolios (url, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`, args: [url, ...keys.map((k) => row[k])] });
  };
  await add(A, { name: "Phone Only", ai_rubric: '{"tier":"A","is_portfolio":true}', health: "live" });
  await add(B, { status: "error", reason: "capture blocked: a bot or security check stood in for the site", shot_key: null, captured_at: null, page_text: null, facts: null, needs_review: 1, capture_attempts: 2, checked_at: "2026-11-22 04:00:00" });
  await add(C, { page_text: "Just a moment... Verifying you are human.", health: "suspect", health_reason: "HTTP 503" });
  await add(D, { ai_rubric: '{"tier":"B","is_portfolio":true}' });
  await add(M, {});
  await add(A2, { name: "Bot Check", ai_rubric: '{"tier":"B","is_portfolio":true}', health: "live" });
  // Captured before captures stored page text: not checked, counted apart under group C.
  await add(U, { page_text: null });
  await db.execute({ sql: "DELETE FROM refresh_failures WHERE url IN (?, ?)", args: [A, A2] });
  await db.execute({ sql: "DELETE FROM status_reviews WHERE url IN (?, ?)", args: [A2, B] });
  const failure = (url, reason) =>
    db.execute({
      sql: "INSERT INTO refresh_failures (url, attempts, failed_at, retry_at, reason) VALUES (?, 2, ?, ?, ?)",
      args: [url, Date.parse("2026-11-22T04:00:00Z"), Date.parse("2026-11-26T04:00:00Z"), reason],
    });
  await failure(A, "error: capture blocked: a bot or security check stood in for the site (phone view)");
  await failure(A2, "error: capture blocked: a bot or security check stood in for the site");
  // On the review list means an open row on /admin/review (the needs_review flag alone is not).
  const review = (url, batch) =>
    db.execute({
      sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, verdicts, signals, status, created_at)
            VALUES (?, ?, 'bot_wall', 'ranked', 'review', 0, 'e2e', '{}', '{}', 'pending', '2026-11-22T04:00:00.000Z')`,
      args: [batch, url],
    });
  await review(A2, "bot-wall:refresh:e2e");
  await review(B, "bot-wall");
  await db.execute({ sql: "DELETE FROM capture_changes WHERE url IN (?, ?)", args: [D, M] });
  const change = (url, lost, oldV, newV, measuring) =>
    db.execute({
      sql: `INSERT INTO capture_changes (url, at, old_v, new_v, old_signs, new_signs, old_chars, new_chars, lost, measuring) VALUES (?, ?, ?, ?, '{}', '{}', 3000, 2900, ?, ?)`,
      args: [url, Date.parse("2026-11-22T05:00:00Z"), oldV, newV, JSON.stringify(lost), measuring],
    });
  await change(D, ["resume", "github"], 2, 2, 0);
  await change(M, ["contact"], 1, 2, 1);
});

test("capture problems: only the admin gets the page and its API", async () => {
  const other = await sessionCookie({ id: 12345 });
  assert.equal((await fetch(`${BASE}/api/admin/capture-problems`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/admin/capture-problems`, { headers: { cookie: other } })).status, 403);
  assert.equal((await fetch(`${BASE}/admin/capture-problems`)).status, 404);
  assert.equal((await fetch(`${BASE}/admin/capture-problems`, { headers: { cookie: other } })).status, 404);
  const api = await (await fetch(`${BASE}/api/admin/capture-problems`, { headers: { cookie } })).json();
  assert.ok(api.A.some((r) => r.url === A));
  assert.ok(api.measuring.some((r) => r.url === M));
  assert.ok(!api.D.some((r) => r.url === M), "a measuring-code change is not counted");
});

test("capture problems: the four groups with counts and a row in each, at desktop and phone widths", async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1280, 900],
      [390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${BASE}/admin/capture-problems`);
      await page.locator("[data-admin-header] h1").waitFor();
      assert.equal(await page.locator("h1").textContent(), "Capture problems");
      for (const g of ["A", "B", "C", "D"]) {
        assert.equal(await page.locator(`[data-capture-group="${g}"]`).count(), 1, `group ${g}`);
        assert.match((await page.locator(`[data-count="${g}"]`).textContent()) ?? "", /^\d+/);
      }
      const row = (g, url) => page.locator(`[data-capture-group="${g}"] [data-capture-problem="${url}"]`).first();
      const a = row("A", A);
      assert.match((await a.locator("[data-reason]").textContent()) ?? "", /only on our second visit at phone size; the desktop view showed the site/);
      assert.equal(await a.locator("[data-phone-only]").count(), 1);
      assert.equal(await a.locator("[data-review]").getAttribute("data-review"), "no");
      assert.equal(await a.locator("[data-grade]").textContent(), "Gemini: tier A");
      assert.equal(await a.locator("[data-capture-again]").count(), 1);
      assert.equal(await a.locator("[data-open-review]").count(), 0);
      const a2 = row("A", A2);
      assert.equal(await a2.locator("[data-review]").getAttribute("data-review"), "yes");
      assert.equal(await a2.locator("[data-open-review]").textContent(), "Open Review");
      assert.equal(await a2.locator("[data-phone-only]").count(), 0);
      const b = row("B", B);
      assert.equal(await b.locator("[data-review]").getAttribute("data-review"), "yes");
      assert.equal(await b.locator("[data-capture-date]").textContent(), "No capture");
      assert.equal(await row("C", C).locator("[data-health]").textContent(), "Health: failing");
      assert.equal(await page.locator(`[data-capture-problem="${U}"]`).count(), 0, "an unmeasured capture is not a bad one");
      assert.match((await page.locator("[data-unmeasured]").textContent()) ?? "", /^Not checked: [\d,]+ captures? (was|were) made before/);
      // The header counts sites, each once.
      assert.match((await page.locator("[data-admin-header]").textContent()) ?? "", /[\d,]+ sites? with an open problem/);
      assert.match((await row("D", D).locator("[data-reason]").textContent()) ?? "", /lost its résumé and GitHub links/);
      assert.equal(await page.locator(`[data-capture-group="D"] > ul [data-capture-problem="${M}"]`).count(), 0, "the measuring change is not in group D's list");
      assert.equal(await page.locator(`[data-measuring] [data-capture-problem="${M}"]`).count(), 1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no sideways scroll at ${width}px`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
