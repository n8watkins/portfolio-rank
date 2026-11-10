// Browser tests for "Deleted · Undo" (components/UndoToast.tsx): deletes happen at once, a toast
// offers Undo for about six seconds, and Undo puts things back exactly where they were.
// They drive the production build that scripts/test-e2e.sh starts, in headless Chromium,
// signed in with a session cookie minted from AUTH_SECRET.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { encode } from "@auth/core/jwt";
import { chromium } from "playwright";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
// The server writes to the same SQLite file: wait for its locks (the server
// waits for ours the same way, lib/db.ts) instead of failing with SQLITE_BUSY.
const db = createClient({ url: DB_URL, timeout: 10000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
let seq = Math.floor(Math.random() * 1e6);

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) break;
    } catch {}
    await sleep(1000);
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** A fresh signed-in browser page with a controllable clock; native dialogs fail the test. */
async function signedInPage({ width = 1280, height = 800 } = {}) {
  const id = String(800000000 + seq++);
  const token = await encode({
    token: { raterId: `gh:${id}`, login: `e2e-${id}`, sub: id },
    secret: process.env.AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 3600,
  });
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies([{ name: "authjs.session-token", value: token, url: BASE }]);
  const page = await context.newPage();
  page.on("dialog", (d) => {
    d.dismiss();
    throw new Error(`a native ${d.type()} dialog opened: ${d.message()}`);
  });
  await page.clock.install();
  return { page, context, raterId: `gh:${id}` };
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ([method, path, body]) => {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body]
  );
}

/** Creates lists oldest first, with distinct dates so the profile order is fixed. */
async function makeLists(page, names) {
  const lists = [];
  for (const [i, name] of names.entries()) {
    const r = await api(page, "POST", "/api/lists", { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await db.execute({ sql: "UPDATE lists SET created_at = datetime('now', ?) WHERE id = ?", args: [`-${names.length - i} minutes`, r.body.id] });
    lists.push(r.body);
  }
  return lists;
}

const listNames = (page) => page.locator("ul li a[href^='/list/']").evaluateAll((els) => els.map((e) => e.firstChild.textContent.trim()));
const toast = (page, text) => page.getByRole("region", { name: "Notifications" }).locator("div.toast-in", { hasText: text });

async function until(fn, expected) {
  let last;
  for (let i = 0; i < 50; i++) {
    last = await fn();
    try {
      assert.deepEqual(last, expected);
      return;
    } catch {}
    await sleep(100);
  }
  assert.deepEqual(last, expected);
}

test("Undo brings a deleted list back in its place, with its items", async () => {
  const { page, context } = await signedInPage();
  await page.goto(BASE + "/profile");
  const [, middle] = await makeLists(page, ["Oldest", "Middle", "Newest"]);
  await api(page, "POST", `/api/lists/${middle.id}/items`, { url: feed[0].url });
  await page.reload();
  await until(() => listNames(page), ["Newest", "Middle", "Oldest"]);

  await page.getByRole("button", { name: "Delete Middle" }).click();
  await toast(page, "“Middle” deleted").waitFor();
  await until(() => listNames(page), ["Newest", "Oldest"]);
  // The toast never takes focus.
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=region]"))), false);

  await toast(page, "“Middle” deleted").getByRole("button", { name: "Undo" }).click();
  await until(() => listNames(page), ["Newest", "Middle", "Oldest"]);
  await page.clock.runFor(10_000);
  await page.reload();
  await until(() => listNames(page), ["Newest", "Middle", "Oldest"]);
  const items = await db.execute({ sql: "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", args: [middle.id] });
  assert.equal(Number(items.rows[0].n), 1);
  await context.close();
});

test("a deleted list is gone for good once the toast runs out", async () => {
  const { page, context } = await signedInPage();
  await page.goto(BASE + "/profile");
  const [doomed] = await makeLists(page, ["Doomed", "Kept"]);
  await api(page, "POST", `/api/lists/${doomed.id}/items`, { url: feed[1].url });
  await page.reload();
  await page.getByRole("button", { name: "Delete Doomed" }).click();
  await toast(page, "“Doomed” deleted").waitFor();
  const finalized = page.waitForRequest((r) => r.url().endsWith(`/api/lists/${doomed.id}/trash`) && r.postDataJSON()?.action === "finalize");
  await page.clock.runFor(6_500);
  await finalized;
  await page.reload();
  await until(() => listNames(page), ["Kept"]);
  await until(async () => Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM lists WHERE id = ?", args: [doomed.id] })).rows[0].n), 0);
  const items = await db.execute({ sql: "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", args: [doomed.id] });
  assert.equal(Number(items.rows[0].n), 0);
  // Gone for good: Undo after the fact is refused.
  assert.equal((await api(page, "POST", `/api/lists/${doomed.id}/trash`, { action: "restore" })).status, 410);
  await context.close();
});

test("deleting from a list's own page goes to the profile, where Ctrl+Z undoes it", async () => {
  const { page, context } = await signedInPage();
  await page.goto(BASE + "/profile");
  const [list] = await makeLists(page, ["Weekend reading"]);
  await page.goto(`${BASE}/list/${list.slug}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL("**/profile");
  await toast(page, "“Weekend reading” deleted").waitFor();
  await until(() => listNames(page), []);
  await page.keyboard.press("Control+z");
  await until(() => listNames(page), ["Weekend reading"]);
  await page.goto(`${BASE}/list/${list.slug}`);
  await page.getByRole("heading", { name: "Weekend reading" }).waitFor();
  await context.close();
});

test("a portfolio removed from a list comes back in the same spot, at phone width", async () => {
  const { page, context } = await signedInPage({ width: 390, height: 844 });
  await page.goto(BASE + "/profile");
  const [list] = await makeLists(page, ["Favorites"]);
  const picks = feed.slice(2, 5);
  for (const [i, p] of picks.entries()) {
    await api(page, "POST", `/api/lists/${list.id}/items`, { url: p.url });
    await db.execute({ sql: "UPDATE list_items SET added_at = datetime('now', ?) WHERE list_id = ? AND url = ?", args: [`-${10 - i} minutes`, list.id, p.url] });
  }
  await page.goto(`${BASE}/list/${list.slug}`);
  const cards = () => page.locator("a[href^='/p/'] p.font-semibold").allTextContents();
  const order = await cards();
  assert.equal(order.length, 3);
  // Visible without hover on a touch-sized screen.
  await page.getByRole("button", { name: `Remove ${order[1]}` }).click();
  await toast(page, `Removed ${order[1]}`).waitFor();
  await until(cards, [order[0], order[2]]);
  const box = await toast(page, `Removed ${order[1]}`).boundingBox();
  assert.ok(box.x >= 16 && box.x + box.width <= 390 - 16, `toast spans ${box.x}..${box.x + box.width}`);
  await toast(page, `Removed ${order[1]}`).getByRole("button", { name: "Undo" }).click();
  await until(cards, order);
  await page.reload();
  await until(cards, order);
  await context.close();
});

test("an unliked portfolio on the profile can be liked again in place", async () => {
  const { page, context } = await signedInPage();
  await page.goto(BASE + "/profile");
  const picks = feed.slice(6, 9);
  for (const [i, p] of picks.entries()) {
    await api(page, "POST", "/api/likes", { url: p.url, want: true });
    await db.execute({ sql: "UPDATE likes SET created_at = datetime('now', ?) WHERE url = ?", args: [`-${10 - i} minutes`, p.url] });
  }
  await page.reload();
  const liked = () => page.locator("a[href^='/p/'] p.font-semibold").allTextContents();
  const order = await liked();
  assert.equal(order.length, 3);
  await page.locator("div.group", { hasText: order[1] }).getByRole("button", { name: "Unlike" }).click();
  await toast(page, `Removed ${order[1]} from your likes`).waitFor();
  await until(liked, [order[0], order[2]]);
  await toast(page, "from your likes").getByRole("button", { name: "Undo" }).click();
  await until(liked, order);
  await page.reload();
  await until(liked, order);
  await context.close();
});
