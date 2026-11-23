// "Report a problem" end to end against the running production build
// (scripts/test-e2e.sh): the route refuses another site's origin, a bad
// reason and an unknown site; on a profile at phone width a visitor opens the
// panel from under the screenshot, picks a reason, adds a note and sends it,
// sees the thanks and stays on the page; the owner sees the site's reports on
// /admin/review grouped with the count, reasons and the note as plain text,
// marks them handled and reopens them. Only the admin gets the admin API.
// Nothing about the site's rating changes.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
// A plain roster site from the middle of the list, which no other test renders.
const plain = feed.filter((p) => !new URL(p.url).search && new URL(p.url).pathname.replace(/\/+$/, "") === "");
const SITE = plain[Math.floor(plain.length / 2)].url;
const NOTE = "Shows a <b>cookie</b> wall, not the site.";
const db = createClient({ url: DB_URL, timeout: 10000 });
let admin;

const post = (body, headers = {}) =>
  fetch(`${BASE}/api/problem-reports`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...headers }, body: JSON.stringify(body) });
const reportsOn = async (url) => (await db.execute({ sql: "SELECT * FROM problem_reports WHERE url = ? ORDER BY id", args: [url] })).rows;
const rating = async (url) => JSON.stringify((await db.execute({ sql: "SELECT * FROM ratings WHERE url = ?", args: [url] })).rows);

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await db.execute({ sql: "DELETE FROM problem_reports WHERE url = ?", args: [SITE] });
  admin = await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
});

test("report route: same origin, a known reason, a known site", async () => {
  assert.equal((await post({ url: SITE, reason: "screenshot" }, { origin: "https://evil.example" })).status, 403);
  const bad = await post({ url: SITE, reason: "rank-it-higher" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_reason");
  const long = await post({ url: SITE, reason: "other", note: "a".repeat(501) });
  assert.equal((await long.json()).error, "note_too_long");
  const unknown = await post({ url: "https://never-listed-e2e.example", reason: "gone" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "unknown_site");
  assert.equal((await reportsOn(SITE)).length, 0);
});

test("admin reports API: only the admin", async () => {
  assert.equal((await fetch(`${BASE}/api/admin/problem-reports`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/admin/problem-reports`, { headers: { cookie: await sessionCookie({ id: 12345 }) } })).status, 403);
  const res = await fetch(`${BASE}/api/admin/problem-reports`, {
    method: "POST",
    headers: { cookie: admin, "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ ids: ["x"], action: "handle" }),
  });
  assert.equal(res.status, 400);
});

test("a visitor reports a profile's screenshot at phone width; the owner sees it and marks it handled", async () => {
  const before = await rating(SITE);
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await phone.newPage();
    await p.goto(`${BASE}/p/${encodeURIComponent(SITE)}`);
    const open = p.locator("[data-report-open]");
    await open.waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll on a phone");
    // It sits right under the screenshot.
    const shot = await p.locator('img[alt^="Screenshot of"]').first().boundingBox();
    const btn = await open.boundingBox();
    assert.ok(btn.y >= shot.y + shot.height - 1 && btn.y - (shot.y + shot.height) < 16, "the button is just below the screenshot");
    assert.ok(btn.height >= 44, "a 44 px target");

    await open.click();
    const dialog = p.getByRole("dialog", { name: "Report a problem" });
    await dialog.waitFor();
    // Sending without a reason asks for one.
    await dialog.locator("[data-report-send]").click();
    await dialog.locator("[data-report-error]").waitFor();
    await dialog.getByLabel("The screenshot is wrong or broken").check();
    await dialog.locator("[data-report-note]").fill(NOTE);
    await dialog.locator("[data-report-send]").click();
    const thanks = p.getByRole("dialog", { name: "Thanks for telling us" });
    await thanks.locator("[data-report-thanks]").waitFor();
    assert.equal(p.url(), `${BASE}/p/${encodeURIComponent(SITE)}`, "the page stays where it was");
    // Done closes it and focus goes back to the button.
    await thanks.locator("[data-report-done]").click();
    await p.locator("dialog[open]").waitFor({ state: "detached" }).catch(() => {});
    assert.equal(await p.locator("dialog[open]").count(), 0);
    assert.equal(await p.evaluate(() => document.activeElement?.hasAttribute("data-report-open")), true, "focus returns to the button");

    const rows = await reportsOn(SITE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "screenshot");
    assert.equal(rows[0].note, NOTE);
    assert.equal(rows[0].status, "open");
    assert.ok(rows[0].reporter && !String(rows[0].reporter).includes("anon:"), "a keyed hash, not the cookie's id");

    // A second visitor, by keyboard on a desktop: Tab to the button, Enter, arrow to a reason, send.
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const d = await desk.newPage();
    await d.goto(`${BASE}/p/${encodeURIComponent(SITE)}`);
    await d.locator("[data-report-open]").focus();
    await d.keyboard.press("Enter");
    const dd = d.getByRole("dialog", { name: "Report a problem" });
    await dd.waitFor();
    await dd.getByLabel("This is not a portfolio").focus();
    await d.keyboard.press("Space");
    await dd.locator("[data-report-send]").focus();
    await d.keyboard.press("Enter");
    await d.getByRole("dialog", { name: "Thanks for telling us" }).waitFor();
    assert.equal((await reportsOn(SITE)).length, 2);

    // The owner's review page: one card for the site, two reports, both reasons, the note as text.
    const owner = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { cookie: admin } });
    const a = await owner.newPage();
    await a.goto(`${BASE}/admin/review`);
    const card = a.locator(`[data-problem-site="${SITE}"]`);
    await card.waitFor();
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll on a phone");
    assert.equal((await card.locator("[data-problem-count]").textContent()).trim(), "2 reports");
    assert.deepEqual((await card.locator("[data-problem-reason]").evaluateAll((els) => els.map((e) => e.getAttribute("data-problem-reason")))).sort(), ["not_portfolio", "screenshot"]);
    const note = card.locator("[data-problem-note]");
    assert.ok((await note.textContent()).includes(NOTE), "the note, as typed");
    assert.equal(await note.locator("b").count(), 0, "rendered as plain text, never HTML");
    assert.equal(await card.locator("[data-problem-site-link]").getAttribute("href"), SITE);
    assert.equal(await card.locator("[data-problem-profile-link]").getAttribute("href"), `/p/${encodeURIComponent(SITE)}`);

    await card.locator("[data-problem-handle]").click();
    await a.locator(`[data-problem-handled-site="${SITE}"]`).waitFor({ state: "attached" });
    assert.equal(await a.locator(`[data-problem-site="${SITE}"]`).count(), 0);
    const handled = await reportsOn(SITE);
    assert.deepEqual(handled.map((r) => r.status), ["handled", "handled"]);
    assert.ok(handled.every((r) => r.handled_by === "admin:e2e-admin" && r.reporter == null));

    // Reopen puts them back.
    await a.locator("[data-problem-handled] summary").click();
    await a.locator(`[data-problem-handled-site="${SITE}"] [data-problem-reopen]`).click();
    await a.locator(`[data-problem-site="${SITE}"]`).waitFor();
    assert.deepEqual((await reportsOn(SITE)).map((r) => r.status), ["open", "open"]);
  } finally {
    await browser.close();
  }
  assert.equal(await rating(SITE), before, "a report changes nothing about the site's rating");
});
