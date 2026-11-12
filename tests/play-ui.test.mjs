// Browser tests for the leaderboard (/top) and Play (/play): the face-off on
// real votes with its keyboard play, undo and announcements, and Guess the
// percentile (GAMES_V2, on in scripts/test-e2e.sh) from the first guess to
// the end card, with no percentile on the page before its guess. Against
// the production build scripts/test-e2e.sh starts; RANKING_V2 is off there,
// so /top is today's ELO board and the AI and People views don't exist.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { ensureRankingSchema } from "../lib/ranking/store.mjs";
import feed from "../data/feed.json" with { type: "json" };

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
// Ten sites on all three boards, so the quiz has a pool of its own.
const SITES = feed.slice(200, 210).map((p) => p.url);
let browser;

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await ensureRankingSchema(db);
  const stmts = [{ sql: `DELETE FROM site_ratings WHERE url IN (${SITES.map(() => "?").join(",")})`, args: SITES }];
  SITES.forEach((url, i) => {
    for (const view of ["merged", "ai", "people"]) {
      stmts.push({
        sql: "INSERT INTO site_ratings (view, url, rank, shown_rank, mu, sigma, confidence, tier) VALUES (?, ?, ?, ?, 25, 3, 'confident', 'B')",
        args: [view, url, 1000 + i, 1000 + i],
      });
    }
    // On today's board, so /top has rows.
    stmts.push({ sql: "INSERT OR REPLACE INTO ratings (url, elo, votes) VALUES (?, ?, 3)", args: [url, 1700 - i * 10] });
  });
  stmts.push(
    { sql: "DELETE FROM cache WHERE k = 'games:pool'", args: [] },
    { sql: "DELETE FROM rate_limits WHERE k LIKE 'quiz-%'", args: [] }
  );
  await db.batch(stmts, "write");
  browser = await chromium.launch();
});

after(async () => {
  await db.execute({ sql: `DELETE FROM site_ratings WHERE url IN (${SITES.map(() => "?").join(",")})`, args: SITES });
  await db.execute("DELETE FROM cache WHERE k = 'games:pool'");
  await browser?.close();
});

async function freshPage(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return { page, context, errors };
}

// /top is rendered at build time and kept for 5 minutes (ISR), and the
// build sees the empty test database: what the e2e run can see is the empty
// board, which must still lead somewhere. The rows are checked by hand
// against seeded data (the PR's screenshots).
test("leaderboard: the empty board leads to Play, and there are no views while RANKING_V2 is off", async () => {
  const { page, context, errors } = await freshPage();
  await page.goto(BASE + "/top");
  await page.getByRole("heading", { level: 1, name: "Leaderboard" }).waitFor();
  const rows = await page.getByRole("main").locator("ol li a").count();
  if (rows === 0) {
    await page.getByText("No portfolios on this board yet.").waitFor();
    assert.equal(await page.getByRole("link", { name: "Cast the first votes" }).getAttribute("href"), "/play");
  } else {
    assert.equal(await page.getByRole("img", { name: /^(Gold|Silver|Bronze) trophy/ }).count(), Math.min(3, rows));
    assert.match(await page.getByRole("main").locator("ol li a").first().getAttribute("href"), /^\/p\//);
  }
  assert.equal(await page.getByRole("navigation", { name: "Leaderboard view" }).count(), 0);
  assert.equal((await fetch(BASE + "/top/ai")).status, 404);
  assert.deepEqual(errors, []);
  await context.close();
});

test("face-off: pick with a key, the crowd's lean is announced, Undo takes it back on a fresh pair", async () => {
  const { page, context, errors } = await freshPage();
  await page.goto(BASE + "/play");
  const picks = page.getByRole("button", { name: /^Pick / });
  await picks.first().waitFor();
  const left = (await picks.first().getAttribute("aria-label")).replace(/^Pick /, "");
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("status").filter({ hasText: `You picked ${left}.` }).waitFor();
  assert.match(await page.getByRole("status").filter({ hasText: "You picked" }).textContent(), /\d+% of people would pick it\. (With the crowd|The underdog|A dead heat for the crowd)\./);
  // The share shows on the cards; the next step has focus.
  assert.equal(await page.getByText("of people would pick this").count(), 2);
  await page.waitForFunction(() => /^Next pair/.test(document.activeElement?.textContent?.trim() ?? ""));
  assert.match(await page.getByText(/^\d+ \/ 5$/).textContent(), /^1 \/ 5$/);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByText("Undid your last vote. Here's a fresh pair.").first().waitFor();
  await picks.first().waitFor();
  assert.match(await page.getByText(/^\d+ \/ 5$/).textContent(), /^0 \/ 5$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("face-off: Simple and Detailed are remembered, and Show picks the parts", async () => {
  const { page, context } = await freshPage();
  await page.goto(BASE + "/play");
  await page.getByRole("button", { name: /^Pick / }).first().waitFor();
  // Detailed by default: the polish checklist and the full Lighthouse rows.
  await page.getByRole("heading", { name: "Polish checklist" }).first().waitFor();
  await page.getByRole("button", { name: "Simple" }).click();
  assert.equal(await page.getByRole("heading", { name: "Polish checklist" }).count(), 0);
  await page.getByRole("heading", { name: "Lighthouse performance" }).first().waitFor();
  // Remembered in this browser.
  await page.reload();
  await page.getByRole("button", { name: /^Pick / }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("heading", { name: "Polish checklist" }).count(), 0);
  // Ticking a part adds it, and the view becomes the viewer's own.
  await page.getByText("Show", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Polish checklist" }).check();
  await page.getByRole("heading", { name: "Polish checklist" }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed"), "false");
  await context.close();
});

test("face-off on a 320px phone: no sideways scroll, and Save and Pick stay inside each card", async () => {
  const { page, context } = await freshPage(320, 640);
  await page.goto(BASE + "/play");
  await page.getByRole("button", { name: /^Pick / }).first().waitFor();
  // The cards are dealt in one after the other: measure once they've landed.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  for (const b of [...(await page.getByRole("button", { name: /^Pick / }).all()), ...(await page.getByRole("button", { name: /^Save / }).all())]) {
    const box = await b.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
    assert.ok(box.height >= 44, `tap target ${box.height}px`);
  }
  await context.close();
});

test("guess the percentile: no percentile before the guess, five rounds, the end card and its challenge link", async () => {
  const { page, context, errors } = await freshPage();
  await page.goto(BASE + "/play?mode=guess");
  assert.equal(await page.getByRole("navigation", { name: "Game mode" }).getByRole("link", { name: /Guess the percentile/ }).getAttribute("aria-current"), "page");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/games/quiz") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Random quiz" }).click();
  const quiz = (await (await created).json()).quiz;
  assert.equal(new URL(page.url()).search, `?mode=guess&quiz=${quiz.id}`);
  assert.equal(quiz.rounds.length, 5);
  for (let k = 0; k < 5; k++) {
    await page.getByRole("button", { name: /^Lock in top \d+%$/ }).waitFor();
    // Nothing on the page tells the answer yet: no Merged/AI/People, no report link.
    assert.equal(await page.getByRole("main").getByText(/^(Merged|AI|People)$/).count(), 0);
    assert.equal(await page.getByRole("link", { name: /^Full profile/ }).count(), 0);
    await page.getByRole("slider", { name: /Your guess/ }).focus();
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("slider", { name: /Your guess/ }).getAttribute("aria-valuetext"), "Top 100 percent");
    await page.getByRole("group", { name: "Quick picks" }).getByRole("button", { name: k % 2 ? "Top 90%" : "Top 10%" }).click();
    // Enter on the slider locks the guess in, as the button does.
    if (k === 0) {
      await page.getByRole("slider", { name: /Your guess/ }).focus();
      await page.keyboard.press("Enter");
    } else await page.getByRole("button", { name: /^Lock in/ }).click();
    const status = page.getByRole("status").filter({ hasText: "points" });
    await status.waitFor();
    assert.match(await status.textContent(), /You said top (10|90)%/);
    await page.getByRole("link", { name: /^Full profile/ }).first().waitFor();
    // The last round leads to the result; every other one to the next portfolio.
    const last = k === quiz.rounds.length - 1;
    await page.getByRole("button", { name: last ? "See your result" : "Next portfolio" }).click();
    if (last) break;
  }
  const head = page.getByRole("heading", { name: /^(\d of 5 within 15 points|Perfect: 5 of 5!)$/ });
  await head.waitFor();
  assert.match(await page.getByText(/^Score \d+ of 500$/).textContent(), /Score \d+ of 500/);
  assert.equal(await page.getByRole("list", { name: "Each guess" }).getByRole("listitem").count(), 5);
  await page.getByRole("heading", { name: "Your eye" }).waitFor();
  // A replay of the same link shows the same end card: each round counts once.
  await page.goto(BASE + quiz.challenge);
  await head.waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("a broken quiz link says so and offers today's Daily 5", async () => {
  const { page, context } = await freshPage(390, 844);
  await page.goto(BASE + "/play?mode=guess&quiz=r-AAAAAAAAAA");
  await page.getByText("That quiz link doesn't work.").waitFor();
  await page.getByRole("button", { name: "Play today's Daily 5" }).click();
  await page.getByRole("button", { name: /^Lock in/ }).waitFor();
  assert.equal(new URL(page.url()).search, "?mode=guess");
  await context.close();
});
