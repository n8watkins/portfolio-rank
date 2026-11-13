// The policy pages (app/privacy, app/terms, app/removal, from docs/legal),
// end to end against the production build scripts/test-e2e.sh starts: each
// answers with its title and canonical, the promises the
// strategy approved are on them, every page's footer links all three, and
// they fit a phone without sideways scrolling.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const PAGES = [
  { path: "/privacy", h1: "Privacy" },
  { path: "/terms", h1: "Terms" },
  { path: "/removal", h1: "Remove or don't name me" },
];
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

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("each policy page answers 200 with its canonical and the policy links", async () => {
  for (const p of PAGES) {
    const res = await fetch(BASE + p.path);
    assert.equal(res.status, 200, p.path);
    const html = await res.text();
    assert.ok(html.includes(`<link rel="canonical" href="https://portfoliorank.n8builds.dev${p.path}"`), `${p.path} canonical`);
    for (const href of ["/privacy", "/terms", "/removal"]) assert.ok(html.includes(`href="${href}"`), `${p.path} links ${href}`);
    assert.ok(!html.includes("—"), `${p.path} has no em dash`);
  }
});

test("the promises: checking adds a site, removal any time, backups expire in 35 days", async () => {
  const privacy = text(await (await fetch(BASE + "/privacy")).text());
  assert.ok(privacy.includes("Checking a site adds it to PortfolioRank; you can ask for removal at any time."));
  assert.ok(privacy.includes("Nightly database backups 35 days"));
  assert.ok(privacy.includes("complete within 35 days"));
  const removal = text(await (await fetch(BASE + "/removal")).text());
  assert.ok(removal.includes("including while it's still waiting to be graded"));
  assert.ok(removal.includes("nate@n8builds.dev"));
  const terms = text(await (await fetch(BASE + "/terms")).text());
  assert.ok(terms.includes("Checking a site adds it to PortfolioRank; you can ask for removal at any time"));
});

test("the footer on every page links the three policies; the pages fit a phone", async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/top");
  const policies = page.getByRole("contentinfo").getByRole("navigation", { name: "Policies" });
  assert.deepEqual(await policies.getByRole("link").allTextContents(), ["Privacy", "Terms", "Remove or don't name me"]);
  for (const p of PAGES) {
    await page.goto(BASE + p.path);
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), p.h1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, `${p.path} scrolls sideways by ${overflow}px`);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
