// Browser tests for browse filters in the address and small-phone layouts,
// against the production build scripts/test-e2e.sh starts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
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
after(async () => {
  await browser?.close();
});

test("search and filters come from the address, update it, and clear", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + "/?q=dev&role=Frontend");
  const search = page.locator("#browse-search");
  await page.waitForFunction(() => document.querySelector("#browse-search")?.value === "dev");
  assert.equal(await page.getByRole("button", { name: "Frontend" }).getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#browse [role=status]").textContent(), /^[\d,]+ of [\d,]+ portfolios$/);

  await search.fill("design");
  await page.getByRole("button", { name: "Names starting with B" }).click();
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("q"), "design");
  assert.equal(url.searchParams.get("letter"), "B");

  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await search.inputValue(), "");
  await page.close();
});

test("home and the leaderboard don't scroll sideways on a 320px phone", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  for (const path of ["/", "/top"]) {
    await page.goto(BASE + path);
    await page.locator("h1").first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320, path);
  }
  // The header stays one 64px row: logo, maker mark and Sign in, nothing wraps.
  await page.goto(BASE + "/");
  const banner = page.getByRole("banner");
  const signIn = banner.getByRole("button", { name: "Sign in" });
  await signIn.waitFor();
  assert.equal(Math.round((await banner.boundingBox()).height), 65); // 64px row + 1px border
  const box = await signIn.boundingBox();
  assert.ok(box.height < 40 && box.x + box.width <= 320, JSON.stringify(box));
  await page.close();
});
