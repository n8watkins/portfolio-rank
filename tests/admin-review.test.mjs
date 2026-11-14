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
const verdicts = (a, b, prompt) =>
  JSON.stringify({
    ...(prompt ? { prompt } : {}),
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
  await add(A, "relist", 1, verdicts(true, true, "portfolio-definition-v2.1"));
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
    // On a phone the viewer fills the screen and its buttons stay on screen.
    await p.locator('[data-review-thumb="desktop"]').first().click();
    const box = await p.locator("[data-review-viewer]").boundingBox();
    assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844], "full screen");
    const reject = await p.locator("[data-review-viewer-reject]").boundingBox();
    assert.ok(reject && reject.y + reject.height <= 844, "Reject is on screen");
    await p.keyboard.press("Escape");
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
    assert.equal(await row(A).locator("[data-review-prompt]").textContent(), "Graded with prompt portfolio-definition-v2.1");
    assert.equal(await row(C).locator("[data-review-prompt]").count(), 0, "no prompt recorded: no line");
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

    // The large viewer: a thumbnail opens it on that view; tabs follow the arrow keys; Esc closes it and
    // focus goes back to the thumbnail; its own Confirm acts on the row.
    const thumb = row(C).locator('[data-review-thumb="phone"]');
    await thumb.click();
    const viewer = page.locator("[data-review-viewer]");
    await viewer.waitFor();
    assert.equal(await viewer.getAttribute("aria-modal"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role") + ":" + document.activeElement?.textContent), "tab:Phone", "focus moves to the selected tab");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await viewer.getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Desktop");
    await page.keyboard.press("End");
    assert.equal(await viewer.getByRole("tab", { name: "Phone" }).getAttribute("aria-selected"), "true");
    // Tab reaches every control and never leaves the viewer.
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      seen.add(await page.evaluate(() => (document.activeElement?.closest("[data-review-viewer]") ? document.activeElement.getAttribute("aria-label") || document.activeElement.textContent?.trim() || document.activeElement.getAttribute("role") : "OUTSIDE")));
    }
    assert.ok(!seen.has("OUTSIDE"), `focus stays in the viewer: ${[...seen].join(", ")}`);
    for (const label of ["Close the screenshot", "Confirm", "Reject"]) assert.ok([...seen].some((s) => s?.includes(label)), `${label} is reachable by Tab: ${[...seen].join(", ")}`);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-review-thumb")), "phone", "focus returns to the thumbnail");

    await row(C).locator('[data-review-thumb="desktop"]').click();
    await viewer.locator("[data-review-viewer-confirm]").click();
    await viewer.getByRole("status").filter({ hasText: "Confirmed" }).waitFor();
    assert.equal(await status(C), "confirmed");
    await viewer.locator("[data-review-viewer-close]").click();
    await viewer.waitFor({ state: "detached" });

    // Decided rows are listed below, folded.
    await page.locator("[data-review-decided] summary").click();
    await page.locator(`[data-review-decided] >> text=${new URL(A).hostname}`).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("applied automatically: its own section with Undo; Undo puts the site back and the row waits for the owner", async () => {
  const { autoApplyReviews } = await import("../lib/reviews/store.mjs");
  const D = "https://e2e-review-auto.dev";
  await db.execute({ sql: "INSERT OR REPLACE INTO portfolios (url, name, status, ai_rubric) VALUES (?, ?, 'live', ?)", args: [D, D, grade(false)] });
  await db.execute({ sql: "DELETE FROM status_reviews WHERE url = ?", args: [D] });
  await db.execute({
    sql: `INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, reason, off_list, verdicts, signals, created_at)
          VALUES ('e2e-auto', ?, 'not_portfolio', 'listed', 'relist', 1, 'Both models see a portfolio.', 0, ?, '{"score":5,"names":[],"junk_rule":null,"capture":{}}', '2026-11-14T00:00:00Z')`,
    args: [D, verdicts(true, true)],
  });
  const applied = await autoApplyReviews(db, { onFeed: () => true, now: new Date() });
  assert.ok(applied.some((r) => r.url === D && r.ok), "the rule applied the pass");
  assert.equal(await isPortfolio(D), true);

  const browser = await chromium.launch();
  try {
    // The phone first: the desktop pass ends with Undo, which empties the section.
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      await page.goto(`${BASE}/admin/review`);
      const section = page.locator("[data-review-auto]");
      await section.getByRole("heading", { name: /Applied automatically/ }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `no sideways scroll at ${width}px`);
      if (width === 390) {
        await context.close();
        continue;
      }
      const row = section.locator("[data-review-auto-row]", { has: page.locator(`a[href="${D}"]`) });
      await row.locator("[data-review-undo]").click();
      await row.waitFor({ state: "detached" });
      assert.equal(await status(D), "pending");
      assert.equal(await isPortfolio(D), false, "the site is back as it was");
      const back = page.locator("[data-review-row]", { has: page.locator(`a[href="${D}"]`) });
      await back.locator("[data-review-undone]").getByText(/then undone by e2e-admin/).waitFor();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
