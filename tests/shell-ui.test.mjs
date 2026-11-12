// Browser tests for the shared shell (components/shell/): the header's
// navigation, the settings menu, the phone tab bar and its More sheet, and the
// skip link, against the production build scripts/test-e2e.sh starts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { sessionToken } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
// "Grade yours" is in the shell only while grading is on (lib/nav.ts ROUTES.grade).
const grading = process.env.GRADER_ENABLED === "true";
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

/** Waits for every finite animation on the page (entrances), never the looping ones. */
const settled = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? "system");
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("desktop header: one Main nav, the current page marked, the maker link named", async () => {
  const { page, context, errors } = await freshPage(1440);
  await page.goto(BASE + "/top");
  const banner = page.getByRole("banner");
  const nav = banner.getByRole("navigation", { name: "Main" });
  await nav.waitFor();
  assert.deepEqual(await nav.getByRole("link").allTextContents(), ["Leaderboard", "Play", "Browse", "Blog"]);
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

test("the header's settings menu sets System, Light or Dark, applies at once and survives a reload without a flash", async () => {
  const { page, context, errors } = await freshPage(1440, 900, { colorScheme: "dark" });
  await page.goto(BASE + "/how");
  const gear = page.getByRole("banner").getByRole("button", { name: "Settings" });
  await gear.waitFor();
  assert.equal(await theme(page), "system");
  const darkBg = await bg(page);

  await gear.click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await menu.waitFor();
  // Theme is one row; Right opens its submenu on the current choice.
  const row = menu.getByRole("menuitem", { name: /^Theme/ });
  assert.ok(await row.evaluate((el) => el === document.activeElement));
  assert.equal(await menu.getByRole("menuitemradio").count(), 0);
  await page.keyboard.press("ArrowRight");
  const sub = page.getByRole("menu", { name: "Theme" });
  await sub.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "System");
  assert.equal(await sub.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked"), "true");
  // On a wide screen it opens beside the menu, not inside it.
  const [m, s] = [await menu.boundingBox(), await sub.boundingBox()];
  assert.ok(s.x + s.width <= m.x + 1, JSON.stringify({ m, s }));
  // Left goes back to the row.
  await page.keyboard.press("ArrowLeft");
  assert.ok(await row.evaluate((el) => el === document.activeElement));
  await row.click();
  await sub.getByRole("menuitemradio", { name: "Light" }).click();
  assert.equal(await theme(page), "light");
  // The menu stays open so the change is seen in place.
  assert.equal(await menu.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked"), "true");
  const lightBg = await bg(page);
  assert.notEqual(lightBg, darkBg);
  assert.equal(await menu.getByRole("menuitem", { name: "All settings" }).getAttribute("href"), "/settings");
  // Escape steps back to the row, then closes the menu.
  await page.keyboard.press("Escape");
  assert.ok(await row.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.ok(await gear.evaluate((el) => el === document.activeElement));

  // The saved choice is on <html> before any script of ours runs.
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("body");
  assert.equal(await theme(page), "light");
  assert.equal(await bg(page), lightBg);

  await gear.click();
  await row.click();
  await menu.getByRole("menuitemradio", { name: "Dark" }).click();
  assert.equal(await theme(page), "dark");
  await menu.getByRole("menuitemradio", { name: "System" }).click();
  assert.equal(await theme(page), "system");
  assert.equal(await page.evaluate(() => localStorage.getItem("pr-theme")), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test("the Settings page sets the theme as a radio group", async () => {
  const { page, context, errors } = await freshPage(390, 844);
  await page.goto(BASE + "/settings");
  const group = page.getByRole("radiogroup", { name: "Theme" });
  await group.waitFor();
  await group.getByRole("radio", { name: "Dark" }).click();
  assert.equal(await theme(page), "dark");
  assert.equal(await group.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"), "true");
  // Arrow keys move the choice, as a radio group should.
  await page.keyboard.press("ArrowLeft");
  assert.equal(await theme(page), "light");
  assert.deepEqual(errors, []);
  await context.close();
});

test("phones: a bottom tab bar with More, which holds settings and sign-in; the settings menu fits", async () => {
  const { page, context, errors } = await freshPage(390, 844);
  await page.goto(BASE + "/top");
  const tabs = page.locator("nav[aria-label=Main]").filter({ hasText: "More" });
  await tabs.waitFor();
  assert.deepEqual(
    (await tabs.locator("a, button").allTextContents()).map((t) => t.trim()),
    grading ? ["Top", "Play", "Grade", "Browse", "More"] : ["Top", "Play", "Browse", "More"]
  );
  if (grading) assert.equal(await tabs.getByRole("link", { name: "Grade" }).getAttribute("href"), "/grade");
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
  assert.equal(await sheet.getByRole("link", { name: "Settings" }).getAttribute("href"), "/settings");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  // The header's settings menu opens inside the screen.
  await page.getByRole("banner").getByRole("button", { name: "Settings" }).click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await menu.waitFor();
  const box = await menu.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  // On a phone the theme choices open inline, under their row.
  await menu.getByRole("menuitem", { name: /^Theme/ }).click();
  const sub = page.getByRole("menu", { name: "Theme" });
  await sub.waitFor();
  const s = await sub.boundingBox();
  assert.ok(s.x >= box.x && s.x + s.width <= box.x + box.width, JSON.stringify({ box, s }));
  await sub.getByRole("menuitemradio", { name: "Dark" }).click();
  assert.equal(await theme(page), "dark");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Sign in from the sheet opens the site's sign-in dialog.
  await tabs.getByRole("button", { name: "More" }).click();
  await sheet.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("dialog", { name: "Sign in to PortfolioRank" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("signed in: the avatar opens an account menu that works from the keyboard", async () => {
  const id = "800900001";
  const token = await sessionToken({ id, login: "e2e-shell" });
  const { page, context, errors } = await freshPage(1440);
  await context.addCookies([{ name: "authjs.session-token", value: token, url: BASE }]);
  await page.goto(BASE + "/settings");
  const avatar = page.getByRole("banner").getByRole("button", { name: "Account: e2e-shell" });
  await avatar.waitFor();
  assert.equal(await page.getByRole("banner").getByRole("button", { name: "Sign in" }).count(), 0);

  await avatar.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await menu.waitFor();
  const items = menu.getByRole("menuitem");
  const first = grading ? "Grade your portfolio" : "Profile, likes and lists";
  assert.deepEqual((await items.allTextContents()).map((t) => t.trim()), [...(grading ? [first] : []), "Profile, likes and lists", "My votes", "ThemeSystem", "All settings", "Sign out"]);
  // The theme is one row, its choices in a submenu.
  assert.equal(await menu.getByRole("menuitemradio").count(), 0);
  // Focus starts on the first item; arrows wrap, Home and End jump.
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.equal(await focused(), first);
  await page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "Sign out");
  await page.keyboard.press("Home");
  assert.equal(await focused(), first);
  await page.keyboard.press("End");
  assert.equal(await focused(), "Sign out");
  // Escape closes it and gives focus back to the avatar.
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.ok(await avatar.evaluate((el) => el === document.activeElement));
  // A click outside closes it too.
  await avatar.click();
  await menu.waitFor();
  await page.locator("h1").click();
  await menu.waitFor({ state: "detached" });
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

test("email sign-up: input and button are separate, side by side when wide, stacked when narrow, with error and success", async () => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, context, errors } = await freshPage(width, 900);
    await page.goto(BASE + "/ui-kit");
    // Measure the settled layout: mid-way through main's entrance (.page-in, a
    // fractional translate) a 44px box can measure 43.99997px.
    await settled(page);
    for (const form of await page.locator("form").filter({ has: page.getByLabel("Your email") }).all()) {
      const input = form.getByLabel("Your email");
      const button = form.getByRole("button", { name: "Subscribe" });
      // Never nested: the button is not inside the input's box or a bordered wrapper of the input.
      const nested = await button.evaluate((b) => {
        for (let el = b.parentElement; el && el.tagName !== "FORM"; el = el.parentElement)
          if (parseFloat(getComputedStyle(el).borderTopWidth) > 0) return true;
        return false;
      });
      assert.equal(nested, false, `button sits in a bordered wrapper at ${width}px`);
      const i = await input.boundingBox();
      const b = await button.boundingBox();
      assert.ok(i.height >= 44 && b.height >= 44, `44px targets at ${width}px: ${JSON.stringify({ i, b })}`);
      const formWidth = (await form.boundingBox()).width;
      if (formWidth >= 384) {
        // Within a pixel: layout lands on half pixels.
        assert.ok(Math.abs(i.y - b.y) < 1, `side by side at ${width}px`);
        assert.ok(Math.abs(i.height - b.height) < 1, "the same height");
        assert.ok(Math.abs(b.x - (i.x + i.width) - 8) < 1, "an 8px gap");
      } else {
        assert.ok(b.y >= i.y + i.height + 7, `stacked at ${width}px`);
        assert.ok(Math.abs(b.width - i.width) < 1, "full width when stacked");
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  const { page, context } = await freshPage(1440, 900);
  await page.goto(BASE + "/ui-kit");
  const form = page.locator("form").filter({ has: page.getByLabel("Your email") }).first();
  const input = form.getByLabel("Your email");
  await input.fill("not-an-address");
  await form.getByRole("button", { name: "Subscribe" }).click();
  await form.getByRole("alert").filter({ hasText: "Enter an email address" }).waitFor();
  assert.equal(await input.getAttribute("aria-invalid"), "true");
  await input.fill("bounce-fail@example.com");
  await form.getByRole("button", { name: "Subscribe" }).click();
  assert.ok(await form.getByRole("button", { name: "Subscribing..." }).isDisabled());
  await form.getByRole("alert").filter({ hasText: "bounced" }).waitFor();
  assert.equal(await input.inputValue(), "bounce-fail@example.com", "the address is kept after an error");
  await input.fill("you@example.com");
  await form.getByRole("button", { name: "Subscribe" }).click();
  await page.getByRole("status").filter({ hasText: "Check your inbox" }).first().waitFor();
  await context.close();
});

test("the UI kit page answers in the test build and is never indexed", async () => {
  // The test build runs with SITE_ENV=test, so here it answers 200; production builds answer 404 (app/ui-kit/page.tsx).
  const res = await fetch(BASE + "/ui-kit");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-robots-tag") ?? (await res.text()), /noindex/);
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
