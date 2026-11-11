// Browser tests for the shared shell (components/shell/): the header's
// navigation, the theme toggle, the phone tab bar and its More sheet, and the
// skip link, against the production build scripts/test-e2e.sh starts.
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

async function freshPage(width, height = 900, options = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return { page, context, errors };
}

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? "system");
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("desktop header: one Main nav, the current page marked, the maker link named", async () => {
  const { page, context, errors } = await freshPage(1440);
  await page.goto(BASE + "/top");
  const banner = page.getByRole("banner");
  const nav = banner.getByRole("navigation", { name: "Main" });
  await nav.waitFor();
  assert.deepEqual(await nav.getByRole("link").allTextContents(), ["Leaderboard", "Play", "Browse"]);
  assert.equal(await nav.getByRole("link", { name: "Leaderboard" }).getAttribute("aria-current"), "page");
  assert.equal(await nav.getByRole("link", { name: "Play" }).getAttribute("aria-current"), null);
  // Every link in the shell goes somewhere that exists.
  for (const href of await page.locator("header a[href^='/'], footer a[href^='/'], nav a[href^='/']").evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")))])) {
    const res = await fetch(BASE + href.split("#")[0], { redirect: "manual" });
    assert.ok(res.status < 400, `${href} answered ${res.status}`);
  }
  const maker = banner.getByRole("link", { name: "n8builds.dev, the maker of PortfolioRank" });
  assert.equal(await maker.getAttribute("href"), "https://n8builds.dev");
  assert.ok(await maker.getByText("n8builds.dev").isVisible(), "the maker's name shows on desktop");
  // The phone tab bar is not shown on desktop.
  assert.equal(await page.locator("nav[aria-label=Main]").filter({ hasText: "More" }).isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("theme toggle cycles System, Light, Dark, applies at once and survives a reload without a flash", async () => {
  const { page, context, errors } = await freshPage(1440, 900, { colorScheme: "dark" });
  await page.goto(BASE + "/how");
  const toggle = page.getByRole("button", { name: /^Theme: / });
  await toggle.waitFor();
  assert.equal(await theme(page), "system");
  const darkBg = await bg(page);

  await toggle.click();
  assert.equal(await theme(page), "light");
  assert.match(await toggle.getAttribute("aria-label"), /^Theme: Light\. Switch to Dark/);
  const lightBg = await bg(page);
  assert.notEqual(lightBg, darkBg);

  // The saved choice is on <html> before any script of ours runs.
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("body");
  assert.equal(await theme(page), "light");
  assert.equal(await bg(page), lightBg);

  await page.getByRole("button", { name: /^Theme: / }).click();
  assert.equal(await theme(page), "dark");
  await page.getByRole("button", { name: /^Theme: / }).click();
  assert.equal(await theme(page), "system");
  assert.equal(await page.evaluate(() => localStorage.getItem("pr-theme")), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test("phones: a bottom tab bar with More, which holds the theme and sign-in", async () => {
  const { page, context, errors } = await freshPage(390, 844);
  await page.goto(BASE + "/top");
  const tabs = page.locator("nav[aria-label=Main]").filter({ hasText: "More" });
  await tabs.waitFor();
  assert.deepEqual(
    (await tabs.locator("a, button").allTextContents()).map((t) => t.trim()),
    ["Top", "Play", "Browse", "More"]
  );
  assert.equal(await tabs.getByRole("link", { name: "Top" }).getAttribute("aria-current"), "page");
  // Every tab is a 44px-plus target, and the bar sits at the bottom edge.
  const boxes = await tabs.locator("a, button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(boxes.every((h) => h >= 44), JSON.stringify(boxes));
  const bar = await tabs.boundingBox();
  assert.equal(Math.round(bar.y + bar.height), 844);
  // The desktop links are hidden; the maker shows as its icon only.
  assert.equal(await page.getByRole("banner").getByRole("navigation").isVisible(), false);

  await tabs.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await sheet.waitFor();
  assert.ok(await sheet.getByRole("link", { name: "Settings" }).isVisible());
  await sheet.getByRole("radio", { name: "Dark" }).click();
  assert.equal(await theme(page), "dark");
  assert.equal(await sheet.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"), "true");
  // Arrow keys move the choice, as a radio group should.
  await page.keyboard.press("ArrowLeft");
  assert.equal(await theme(page), "light");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  // Sign in from the sheet opens the site's sign-in dialog.
  await tabs.getByRole("button", { name: "More" }).click();
  await sheet.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("dialog", { name: "Sign in to PortfolioRank" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("the skip link is the first Tab stop and moves focus to main", async () => {
  const { page, context } = await freshPage(1440);
  await page.goto(BASE + "/removed");
  await page.locator("h1").waitFor();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  assert.ok(await skip.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "main");
  // One main landmark, with the page's one h1 inside it.
  assert.equal(await page.locator("main").count(), 1);
  assert.equal(await page.locator("main h1").count(), 1);
  await context.close();
});

test("no page in the shell scrolls sideways from 320 to 1440px", async () => {
  for (const width of [320, 768, 1024, 1440]) {
    const { page, context } = await freshPage(width, 800);
    for (const path of ["/top", "/how", "/removed", "/settings", "/rank", "/zz-no-such-page"]) {
      await page.goto(BASE + path);
      await page.locator("h1").first().waitFor();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(over, 0, `${path} at ${width}px overflows by ${over}px`);
    }
    await context.close();
  }
});
