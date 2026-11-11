// Browser tests for the shared dialog (components/Modal.tsx) and the /rank
// keyboard shortcuts, against the production build scripts/test-e2e.sh starts.
// They guard the November 2026 audit's sign-in findings: the dialog used to
// open trapped inside the header or a card, and arrow keys voted behind it.
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

async function freshPage(width = 1280, height = 800) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  return { page, context };
}

const dialogState = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog[open]");
    return d
      ? {
          modal: d.matches(":modal"),
          parentIsBody: d.parentElement === document.body,
          focusInside: d.contains(document.activeElement),
          name: document.getElementById(d.getAttribute("aria-labelledby"))?.textContent,
          scrollLocked: document.documentElement.style.overflow === "hidden",
        }
      : null;
  });

test("Sign in opens a real modal: top layer, focus inside, Escape closes and returns focus", async () => {
  const { page, context } = await freshPage();
  await page.goto(BASE + "/");
  const signIn = page.getByRole("banner").getByRole("button", { name: "Sign in" });
  await signIn.click();
  await page.locator("dialog[open]").waitFor();
  assert.deepEqual(await dialogState(page), {
    modal: true,
    parentIsBody: true,
    focusInside: true,
    name: "Sign in to PortfolioRank",
    scrollLocked: true,
  });
  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Sign in");
  // The scroll lock lifts once React has seen the close.
  await page.waitForFunction(() => document.documentElement.style.overflow === "", null, { timeout: 2000 });
  await context.close();
});

test("a card's heart opens the dialog without following the card's link, at phone width", async () => {
  const { page, context } = await freshPage(390, 844);
  await page.goto(BASE + "/");
  await page.locator("#browse").getByRole("button", { name: /^Like / }).first().click();
  await page.locator("dialog[open]").waitFor();
  assert.equal((await dialogState(page)).name, "Sign in to like portfolios");
  assert.equal(new URL(page.url()).pathname, "/");
  // The close button closes it and the page stays put.
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  assert.equal(new URL(page.url()).pathname, "/");
  await context.close();
});

test("/?signin opens the dialog and tidies the address; signed-out profile uses it too", async () => {
  const { page, context } = await freshPage();
  await page.goto(BASE + "/?signin=1&callbackUrl=%2Fvotes");
  await page.locator("dialog[open]").waitFor();
  assert.equal(page.url(), BASE + "/");
  await page.keyboard.press("Escape");
  await page.goto(BASE + "/profile");
  await page.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await page.locator("dialog[open]").waitFor();
  // Auth.js's own sign-in page now sends people to the dialog as well.
  const res = await fetch(BASE + "/api/auth/signin", { redirect: "manual" });
  assert.match(res.headers.get("location") ?? "", /\/\?signin=1/);
  await context.close();
});

test("/rank arrow keys stand down under a dialog and with modifiers, and don't scroll", async () => {
  const { page, context } = await freshPage();
  let votes = 0;
  page.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/rank" && votes++);
  await page.goto(BASE + "/rank");
  // First visit: the sign-in nudge opens by itself.
  await page.locator("dialog[open]").waitFor();
  await page.getByRole("button", { name: /^Pick / }).first().waitFor();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Control+ArrowLeft");
  await page.waitForTimeout(300);
  assert.equal(votes, 0);
  assert.equal(new URL(page.url()).pathname, "/rank");

  const before = await page.evaluate(() => scrollY);
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("status").filter({ hasText: /wins/ }).waitFor();
  assert.equal(votes, 1);
  assert.equal(await page.evaluate(() => scrollY), before);
  await context.close();
});
