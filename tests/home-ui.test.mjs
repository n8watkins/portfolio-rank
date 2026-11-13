// Browser tests for the home page (app/page.tsx), its hero card deck
// (components/home/Showcase.tsx, shown on /ui-kit with stand-in frames) and
// the visitor's portfolio page (app/me/page.tsx), against the production
// build scripts/test-e2e.sh starts with GRADER_ENABLED and GAMES_V2 on. A
// grade starts from the home form for real, with a local stand-in for the
// portfolio site and GitHub's API (as tests/grader-api.test.mjs does); this
// test then finishes it in the database the way the grade workflow would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { AI_CRITERIA } from "../pipeline/rubric.mjs";
import { buildReport } from "../lib/grader/report.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const MOCK_PORT = Number(process.env.E2E_GRADER_MOCK_PORT ?? 7693);
const grading = process.env.GRADER_ENABLED === "true";
const db = createClient({ url: DB_URL, timeout: 10000 });
let browser;
let mock;

const SITE_HTML = `<!doctype html><html><head><title>Home Tester</title></head><body>
<h1>Home Tester, designer</h1><p>I design calm, fast interfaces.</p>
<a href="https://github.com/home-tester">GitHub</a> <a href="mailto:home@example.com">Email</a>
<footer>© 2026 Home Tester</footer></body></html>`;

before(async () => {
  mock = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/site") {
        const host = new URL(url.searchParams.get("u")).hostname;
        if (host.startsWith("home-e2e")) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SITE_HTML);
        return res.writeHead(404).end();
      }
      if (url.pathname.endsWith("/dispatches")) return res.writeHead(200, { "content-type": "application/json" }).end('{"workflow_run_id":1}');
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
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
  mock?.close();
});

async function freshPage(width, height = 900, options = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|turnstile|challenges\.cloudflare/i.test(m.text()) && errors.push(m.text()));
  return { page, context, errors };
}

const caption = (deck) => deck.locator("p[aria-live]").locator("span.font-semibold").first().textContent();

test("the hero deck: one link in front, 44px controls, dots and a counter, pauses on hover", async () => {
  const { page, context, errors } = await freshPage(1440);
  await page.goto(BASE + "/ui-kit");
  const deck = page.getByRole("region", { name: "Top graded portfolios" });
  await deck.scrollIntoViewIfNeeded();

  // Only the front card is a link; the cards behind it are hidden from everyone.
  const links = deck.getByRole("link");
  assert.equal(await links.count(), 1);
  assert.equal(await links.first().getAttribute("aria-label"), "See the report for Ada");
  assert.equal(await deck.locator("div[aria-hidden=true].pointer-events-none").count(), 3);
  assert.equal(await caption(deck), "Ada");
  assert.match(await deck.textContent(), /1 of 4/);

  for (const name of ["Previous portfolio", "Pause the showcase", "Next portfolio"]) {
    const box = await deck.getByRole("button", { name }).boundingBox();
    // Rounded: layout can put a 44px box at 43.9998px (subpixel positions).
    assert.ok(Math.round(box.width) >= 44 && Math.round(box.height) >= 44, `${name}: ${JSON.stringify(box)}`);
  }

  // "See report" shows on hover of the front card.
  const label = links.first().getByText("See report →");
  assert.equal(await label.evaluate((el) => getComputedStyle(el).opacity), "0");
  await links.first().hover();
  await page.waitForFunction((el) => getComputedStyle(el).opacity === "1", await label.elementHandle());

  // Next, previous and the dots all move the front card, and the caption follows.
  await page.mouse.move(0, 0);
  await deck.getByRole("button", { name: "Next portfolio" }).click();
  assert.equal(await caption(deck), "Grace");
  await deck.getByRole("button", { name: "4: Margaret" }).click();
  assert.equal(await caption(deck), "Margaret");
  assert.equal(await deck.getByRole("button", { name: "4: Margaret" }).getAttribute("aria-current"), "true");
  await deck.getByRole("button", { name: "Previous portfolio" }).click();
  assert.equal(await caption(deck), "Linus");
  assert.equal(await deck.getByRole("link").getAttribute("aria-label"), "See the report for Linus");

  // Hovering holds it still past the 4.2s turn.
  await deck.hover();
  await page.waitForTimeout(5000);
  assert.equal(await caption(deck), "Linus");
  // Away from it, it turns on its own.
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForFunction((el) => el.querySelector("p[aria-live] span.font-semibold")?.textContent !== "Linus", await deck.elementHandle(), { timeout: 8000 });

  // The pause button stops it.
  await deck.getByRole("button", { name: "Pause the showcase" }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  const held = await caption(deck);
  await page.waitForTimeout(5000);
  assert.equal(await caption(deck), held);
  assert.ok(await deck.getByRole("button", { name: "Play the showcase" }).isVisible());
  assert.deepEqual(errors, []);
  await context.close();
});

test("under reduced motion the deck never turns on its own and has nothing to pause", async () => {
  const { page, context } = await freshPage(1440, 900, { reducedMotion: "reduce" });
  await page.goto(BASE + "/ui-kit");
  const deck = page.getByRole("region", { name: "Top graded portfolios" });
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(5000);
  assert.equal(await caption(deck), "Ada");
  assert.equal(await deck.getByRole("button", { name: /Pause|Play/ }).isVisible(), false);
  await deck.getByRole("button", { name: "Next portfolio" }).click();
  assert.equal(await caption(deck), "Grace");
  await context.close();
});

test("home, browse and /me don't scroll sideways from 320 to 1440px", async () => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const { page, context, errors } = await freshPage(width, 800);
    for (const path of ["/", "/browse", "/me"]) {
      await page.goto(BASE + path);
      await page.locator("h1").first().waitFor({ state: "attached" });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(over, 0, `${path} at ${width}px overflows by ${over}px`);
    }
    assert.deepEqual(errors, [], `console errors at ${width}px`);
    await context.close();
  }
});

test("old browse links land on /browse with their filters", async () => {
  const { page, context } = await freshPage(1280);
  await page.goto(BASE + "/?q=dev&role=Frontend");
  await page.waitForURL(/\/browse\?q=dev&role=Frontend$/);
  await page.goto(BASE + "/#browse");
  await page.waitForURL(/\/browse$/);
  await page.locator("#browse-search").waitFor();
  await context.close();
});

test("the home grade form: the free-tier note where a grade starts, and a plain error for a bad address", { skip: !grading }, async () => {
  const { page, context } = await freshPage(1440);
  await page.goto(BASE + "/");
  await page.getByRole("heading", { level: 1, name: /How good is your portfolio/ }).waitFor();
  const form = page.locator("#grade form");
  await form.getByText(/Grades run on Google Gemini's free tier/).waitFor();
  await form.getByLabel("Your portfolio address").fill("not a site");
  await form.getByRole("button", { name: "Grade it" }).click();
  await form.getByRole("alert").filter({ hasText: "Paste your portfolio's address" }).waitFor();
  assert.equal(await form.getByLabel("Your portfolio address").getAttribute("aria-invalid"), "true");
  // "Use your own key" opens the key field in the same form.
  await form.getByRole("button", { name: "Use your own key" }).click();
  assert.ok(await form.getByLabel("Your Gemini API key").isVisible());
  await context.close();
});

test("a grade from home: its progress page, and /me follows it to the report", { skip: !grading }, async () => {
  const { page, context, errors } = await freshPage(1440);
  // A first visit to /me offers the grade form.
  await page.goto(BASE + "/me");
  await page.getByRole("heading", { level: 1, name: /lives here once it's graded/ }).waitFor();

  await page.goto(BASE + "/");
  const form = page.locator("#grade form");
  await form.getByLabel("Your portfolio address").fill("home-e2e.dev");
  await form.getByRole("button", { name: "Grade it" }).click();
  // The form leads to the grade's own page, which follows it.
  await page.waitForURL(/\/grade\/[A-Za-z0-9_-]{16,}$/, { timeout: 20000 });
  await page.getByRole("heading", { level: 1, name: "home-e2e.dev" }).waitFor();
  await page.getByRole("progressbar", { name: "Grade progress" }).waitFor();
  // /me shows the same grade.
  await page.goto(BASE + "/me");
  await page.getByRole("heading", { level: 1, name: "Your report on home-e2e.dev is being prepared" }).waitFor();
  const bar = page.getByRole("progressbar", { name: "Report progress" });
  assert.equal(await bar.getAttribute("aria-valuenow"), "1");
  await page.getByText("Measuring: resume, GitHub, links, domain").waitFor();

  // The grade workflow's part: the capture lands and Gemini grades it.
  const job = (await db.execute("SELECT id, url FROM grade_jobs WHERE url LIKE 'https://home-e2e.dev%' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.ok(job, "the job exists");
  const grade = {
    is_portfolio: true,
    tier: "B",
    roles: ["designer"],
    checks: { github: true, contact: true, resume: false, own_domain: true, fresh_footer: true },
    facts: { footer_year: 2026 },
    ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: c.id === "writing" ? 2 : 4, note: `${c.name} note` }])),
    judged_at: new Date().toISOString(),
    model: "gemini-e2e",
  };
  const report = buildReport(grade, [], {});
  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE grade_jobs SET status = 'done', reason = NULL, result = ?, report = ?, done_at = ?, captured_at = ? WHERE id = ?",
    args: [JSON.stringify(grade), JSON.stringify(report), now, now, String(job.id)],
  });

  // The page notices on its next look and shows the report.
  await page.getByRole("heading", { level: 1, name: "home-e2e.dev" }).waitFor({ timeout: 15000 });
  await page.getByText("Tier B").first().waitFor();
  const fixes = page.getByRole("region", { name: "What to improve" });
  assert.ok((await fixes.getByRole("listitem").count()) >= 1);
  assert.match(await fixes.textContent(), /Tighten the writing|Link your resume/);
  assert.match(await page.getByRole("region", { name: "Latest face-offs" }).textContent(), /Not on the leaderboard yet/);
  // Re-grades wait a week: the button says so and stays off.
  assert.ok(await page.getByRole("button", { name: "Request a re-grade" }).isDisabled());
  await page.getByText(/Next re-grade available in 7 days/).waitFor();

  // On a phone the badges show what's earned and the next three; the rest wait behind a button.
  await page.setViewportSize({ width: 390, height: 844 });
  const badges = page.getByRole("region", { name: /Badges/ });
  const show = badges.getByRole("button", { name: /Show all \d+ badges/ });
  await show.waitFor();
  // Plain li, not the listitem role: hidden items have no role, and these count them.
  const visible = () => badges.locator("li").evaluateAll((els) => els.filter((el) => el.offsetParent !== null).length);
  const total = await badges.locator("li").count();
  assert.ok((await visible()) < total, "some badges wait behind the button");
  await show.click();
  assert.equal(await visible(), total);
  assert.equal(await show.count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
