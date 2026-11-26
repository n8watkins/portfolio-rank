// "Re-check my site" (components/profile/RecheckButton.tsx): after a good
// re-check the page reloads, and the owner must see on the new page that the
// speed numbers update within a day (the daily job measures them). Headless
// Chromium against the running app, with /api/recheck answered by the test
// (the owner proof itself is tests/ownership-e2e.test.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const MESSAGE = "Re-checked. The speed numbers update within a day.";
const PROFILE = `${BASE}/p/${encodeURIComponent(feed[300].url)}`;
let browser;

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  browser = await chromium.launch();
});
after(() => browser?.close());

/** A page whose /api/recheck says the visitor is the owner, and answers a re-check like the real route. */
async function ownerPage(viewport, { storage = true } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // Storage that refuses writes (a full or blocked store): the page's own code must not be affected.
  if (!storage) await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("blocked", "QuotaExceededError"); }; });
  let nextAt = null;
  await page.route("**/api/recheck**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      nextAt = new Date(Date.now() + 3600_000).toISOString();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, nextAt, message: MESSAGE }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ owner: true, nextAt }) });
  });
  await page.goto(PROFILE, { waitUntil: "networkidle" });
  return { page, context };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1366, height: 800 }]]) {
  test(`${name}: the owner sees that the speed numbers update within a day, once, after the reload`, async () => {
    const { page, context } = await ownerPage(viewport);
    const button = page.getByRole("button", { name: "Re-check my site" });
    await button.waitFor();
    assert.equal(await page.getByRole("status").filter({ hasText: "within a day" }).count(), 0, "no notice before a re-check");
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), button.click()]);
    const notice = page.getByRole("status").filter({ hasText: "within a day" });
    await notice.waitFor();
    assert.equal((await notice.innerText()).trim(), MESSAGE);
    assert.equal(await overflow(page), false, "no horizontal scroll");
    const box = await notice.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, "the notice is inside the screen");
    assert.ok(await page.getByText(/^Again at /).isVisible(), "the hourly limit note is still shown beside it");
    // Shown once: the next load has none.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Re-check my site" }).waitFor();
    assert.equal(await page.getByRole("status").filter({ hasText: "within a day" }).count(), 0);
    await context.close();
  });
}

test("with browser storage refusing writes the re-check still reloads, without the notice", async () => {
  const { page, context } = await ownerPage({ width: 390, height: 844 }, { storage: false });
  const button = page.getByRole("button", { name: "Re-check my site" });
  await button.waitFor();
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), button.click()]);
  await page.getByText(/^Again at /).waitFor();
  assert.equal(await page.getByRole("status").filter({ hasText: "within a day" }).count(), 0);
  await context.close();
});
