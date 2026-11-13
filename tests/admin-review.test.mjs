// The admin Review page (/admin/review, lib/reviews/store.mjs) end to end
// against the running production build (scripts/test-e2e.sh): only the admin
// gets it; agreed rows come ticked and a disagreement is flagged and
// unticked; a row's Confirm applies its change; "Confirm all where everyone
// agrees" asks once more, then applies the ticked rows; the phone width has
// no sideways scroll.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const A = "https://e2e-review-agreed.dev";
const B = "https://e2e-review-remove.dev";
const C = "https://e2e-review-flagged.dev";

let cookie;
let db;
const grade = (isPortfolio) => JSON.stringify({ tier: "B", is_portfolio: isPortfolio, model: "gemini-3.1-flash-lite", visual_design: { score: 3 }, project_presentation: { score: 3 }, writing: { score: 3 } });
const verdicts = (a, b) =>
  JSON.stringify({
    gemini31: { batch: { is_portfolio: a, reason: "Gemini's reason.", scores: { visual_design: 3, project_presentation: 2, writing: 3 } }, solo: null },
    haiku: { batch: { is_portfolio: b, reason: "Haiku's reason.", scores: { visual_design: 3, project_presentation: 3, writing: 3 } }, solo: null },
  });
const status = async (url) => String((await db.execute({ sql: "SELECT status FROM status_reviews WHERE url = ?", args: [url] })).rows[0].status);
const isPortfolio = async (url) => JSON.parse(String((await db.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0].ai_rubric)).is_portfolio;

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
  assert.equal((await fetch(`${BASE}/api/admin/review`, { headers: { cookie } })).status, 200);
  db = createClient({ url: DB_URL, timeout: 10000 });
  for (const [url, g] of [
    [A, grade(false)],
    [B, grade(true)],
    [C, grade(false)],
  ]) {
    await db.execute({ sql: "INSERT OR REPLACE INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: [url, url, g] });
  }
  await db.execute("DELETE FROM status_reviews WHERE batch = 'e2e'");
  const add = (url, proposed, agreed, v) =>
    db.execute({
      sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, created_at)
            VALUES ('e2e', ?, 'not_portfolio', 'listed', ?, ?, 'A plain sentence why.', 0, ?, '{"score":4,"names":["name","projects","about","contact"],"capture":{"action":"pressed Escape on a dialog","blocked":null,"failed":null}}', '2026-11-14T00:00:00Z')`,
      args: [url, proposed, agreed, v],
    });
  await add(A, "relist", 1, verdicts(true, true));
  await add(B, "remove", 1, verdicts(false, false));
  await add(C, "relist", 0, verdicts(true, false));
});

test("review API: only the admin", async () => {
  assert.equal((await fetch(`${BASE}/api/admin/review`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/admin/review`, { headers: { cookie: await sessionCookie({ id: 12345 }) } })).status, 403);
  const post = await fetch(`${BASE}/api/admin/review`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ ids: ["x"], action: "confirm" }) });
  assert.equal(post.status, 400);
});

test("review page: agreed rows ticked, disagreements flagged; Confirm applies; the bulk button asks first", async () => {
  const browser = await chromium.launch();
  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { cookie } });
    const p = await phone.newPage();
    await p.goto(`${BASE}/admin/review`);
    await p.locator("[data-review-row]").first().waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll on a phone");
    await phone.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { cookie } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${BASE}/admin/review`);
    const row = (url) => page.locator("[data-review-row]", { has: page.locator(`a[href="${url}"]`) });
    await row(A).waitFor();
    assert.equal(await row(A).getByRole("checkbox").isChecked(), true);
    assert.equal(await row(B).getByRole("checkbox").isChecked(), true);
    assert.equal(await row(C).getByRole("checkbox").isChecked(), false);
    await row(C).getByText("Graders disagree").waitFor();
    assert.equal(await row(A).locator("[data-review-action]").textContent(), "Before the screenshot: pressed Escape on a dialog");
    assert.equal(await isPortfolio(A), false, "nothing applied before a decision");

    // One row, on its own.
    await row(A).locator("[data-review-confirm]").click();
    await row(A).waitFor({ state: "detached" });
    assert.equal(await status(A), "confirmed");
    assert.equal(await isPortfolio(A), true);

    // The rest that everyone agrees on: one more click to apply.
    const bulk = page.locator("[data-review-bulk]");
    await bulk.filter({ hasText: "Confirm all where everyone agrees (1)" }).waitFor();
    await bulk.click();
    await page.locator("[data-review-bulk-yes]", { hasText: "Yes, apply 1 change" }).click();
    await row(B).waitFor({ state: "detached" });
    assert.equal(await status(B), "confirmed");
    assert.equal(await isPortfolio(B), false);
    assert.equal(await status(C), "pending", "the disagreement waits");

    // Decided rows are listed below, folded.
    await page.locator("[data-review-decided] summary").click();
    await page.locator(`[data-review-decided] >> text=${new URL(A).hostname}`).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
