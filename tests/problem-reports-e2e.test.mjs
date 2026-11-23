// "Report a problem" end to end against the running production build
// (scripts/test-e2e.sh):
// - the route refuses another site's origin, a bad reason, a long note and
//   any address without a live profile (never listed, only waiting for a
//   capture, stopped working, removed by its owner);
// - a request without cf-connecting-ip is not exempt from the network
//   limits: all such requests share one "unknown" network;
// - on a profile at phone width a visitor opens the panel from under the
//   screenshot, picks a reason, adds a note and sends it, sees the thanks and
//   stays on the page; a second visitor does it by keyboard on a desktop;
// - when Cloudflare shows its checkbox, the panel says to tick it and waits
//   (nothing is sent without the token), then sends with it;
// - offline, the panel says so, keeps what was typed, and sends once back;
// - the owner sees the site's reports on /admin/review grouped with the
//   count, reasons and the note as plain text, marks them handled and
//   reopens them; a report the visitor resent after his page loaded stays
//   open with a message.
// Only the admin gets the admin API. Nothing about the site's rating changes.
// Each browser and request names its own address (cf-connecting-ip), so the
// tests never share a network bucket by accident.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
// Plain roster sites from the middle of the list, which no other test renders.
const plain = feed.filter((p) => !new URL(p.url).search && new URL(p.url).pathname.replace(/\/+$/, "") === "");
const mid = Math.floor(plain.length / 2);
const SITE = plain[mid].url;
const REMOVED = plain[mid + 1].url;
const GONE = plain[mid + 2].url;
const TICK = plain[mid + 3].url;
const CANDIDATE = "https://capture-candidate-e2e.example";
const NOTE = "Shows a <b>cookie</b> wall, not the site.";
const db = createClient({ url: DB_URL, timeout: 10000 });
let admin;
let ipSeq = 10;
/** A fresh IPv4 address per caller, so each has its own network limits. */
const ip = () => `198.51.100.${ipSeq++}`;

const post = (body, headers = {}) =>
  fetch(`${BASE}/api/problem-reports`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "cf-connecting-ip": ip(), ...headers }, body: JSON.stringify(body) });
const reportsOn = async (url) => (await db.execute({ sql: "SELECT * FROM problem_reports WHERE url = ? ORDER BY id", args: [url] })).rows;
const rating = async (url) => JSON.stringify((await db.execute({ sql: "SELECT * FROM ratings WHERE url = ?", args: [url] })).rows);
const profile = (url) => `${BASE}/p/${encodeURIComponent(url)}`;
const context = (browser, opts = {}) => browser.newContext({ ...opts, extraHTTPHeaders: { "cf-connecting-ip": ip(), ...(opts.extraHTTPHeaders ?? {}) } });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await db.execute({ sql: "DELETE FROM problem_reports WHERE url IN (?, ?)", args: [SITE, TICK] });
  // An address that only waits for a capture, a site whose owner removed it, and one that stopped working.
  await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [CANDIDATE] });
  await db.execute({ sql: "INSERT OR REPLACE INTO portfolio_owner (url, removed_at, updated_at) VALUES (?, ?, ?)", args: [REMOVED, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"] });
  await db.execute({ sql: "INSERT INTO portfolios (url, status, health) VALUES (?, 'live', 'down') ON CONFLICT(url) DO UPDATE SET health = 'down'", args: [GONE] });
  admin = await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
});

// The removed and stopped sites go back as they were, for the tests that run after this file.
after(async () => {
  await db.execute({ sql: "DELETE FROM portfolio_owner WHERE url = ?", args: [REMOVED] });
  await db.execute({ sql: "UPDATE portfolios SET health = NULL WHERE url = ?", args: [GONE] });
  await db.execute({ sql: "DELETE FROM portfolios WHERE url = ?", args: [CANDIDATE] });
});

test("report route: same origin, a known reason, a live profile", async () => {
  assert.equal((await post({ url: SITE, reason: "screenshot" }, { origin: "https://evil.example" })).status, 403);
  const bad = await post({ url: SITE, reason: "rank-it-higher" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_reason");
  const long = await post({ url: SITE, reason: "other", note: "a".repeat(501) });
  assert.equal((await long.json()).error, "note_too_long");
  for (const url of ["https://never-listed-e2e.example", CANDIDATE, REMOVED, GONE]) {
    const res = await post({ url, reason: "gone" });
    assert.equal(res.status, 404, url);
    assert.equal((await res.json()).error, "unknown_site", url);
    assert.equal((await reportsOn(url)).length, 0, url);
  }
  assert.equal((await reportsOn(SITE)).length, 0);
});

test("report route: requests without cf-connecting-ip share one network and hit its limit", async () => {
  const bare = () =>
    fetch(`${BASE}/api/problem-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ url: "https://never-listed-e2e.example", reason: "gone" }),
    });
  // Six an hour per network (lib/problem-reports/intake.mjs LIMITS.NETWORK_HOUR): each gets past the limit to the site check.
  for (let i = 0; i < 6; i++) assert.equal((await bare()).status, 404, `attempt ${i + 1}`);
  const over = await bare();
  assert.equal(over.status, 429, "no address is not a way around the network limit");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  // A request that names its own address is not caught by the shared bucket.
  assert.equal((await post({ url: "https://never-listed-e2e.example", reason: "gone" })).status, 404);
});

test("admin reports API: only the admin, and well-formed decisions", async () => {
  assert.equal((await fetch(`${BASE}/api/admin/problem-reports`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/admin/problem-reports`, { headers: { cookie: await sessionCookie({ id: 12345 }) } })).status, 403);
  const send = (body) =>
    fetch(`${BASE}/api/admin/problem-reports`, { method: "POST", headers: { cookie: admin, "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });
  assert.equal((await send({ ids: ["x"], action: "reopen" })).status, 400);
  assert.equal((await send({ ids: [1], action: "handle" })).status, 400, "handle needs what the page saw");
  assert.equal((await send({ reports: [{ id: 1 }], action: "handle" })).status, 400);
  assert.equal((await send({ reports: [{ id: 1, updatedAt: "yesterday" }], action: "handle" })).status, 400);
});

test("a visitor reports a profile's screenshot at phone width; the owner sees it, marks it handled and reopens it", async () => {
  const before = await rating(SITE);
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  try {
    const phone = await context(browser, { viewport: { width: 390, height: 844 } });
    const p = await phone.newPage();
    await p.goto(profile(SITE));
    const open = p.locator("[data-report-open]");
    await open.waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll on a phone");
    // It sits right under the screenshot.
    const shot = await p.locator('img[alt^="Screenshot of"]').first().boundingBox();
    const btn = await open.boundingBox();
    assert.ok(btn.y >= shot.y + shot.height - 1 && btn.y - (shot.y + shot.height) < 16, "the button is just below the screenshot");
    assert.ok(btn.height >= 44, "a 44 px target");
    // Turnstile's script loads only once the panel opens, never on a plain profile view.
    assert.equal(await p.locator('script[src*="challenges.cloudflare.com"]').count(), 0, "no bot-check script before the panel opens");

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
    assert.equal(p.url(), profile(SITE), "the page stays where it was");
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

    // A second visitor, by keyboard on a desktop: Tab to the button, Enter, a reason, send.
    const desk = await context(browser, { viewport: { width: 1280, height: 900 } });
    const d = await desk.newPage();
    await d.goto(profile(SITE));
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
    const owner = await context(browser, { viewport: { width: 390, height: 844 }, extraHTTPHeaders: { cookie: admin } });
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

    // While the owner reads, the first visitor changes their report: Mark handled leaves that one open and says so.
    const resent = await p.request.post(`${BASE}/api/problem-reports`, {
      headers: { origin: BASE, "content-type": "application/json" },
      data: { url: SITE, reason: "measurement", note: "Actually the projects count is wrong." },
    });
    assert.equal(resent.status(), 200);
    await card.locator("[data-problem-handle]").click();
    await card.getByText(/1 report changed since this page loaded and stays open/).waitFor();
    await card.getByText("Actually the projects count is wrong.").waitFor();
    assert.deepEqual((await reportsOn(SITE)).map((r) => r.status), ["open", "handled"]);

    // Now the owner has seen it: Mark handled closes it.
    await card.locator("[data-problem-handle]").click();
    await a.locator(`[data-problem-site="${SITE}"]`).waitFor({ state: "detached" });
    const handled = await reportsOn(SITE);
    assert.deepEqual(handled.map((r) => r.status), ["handled", "handled"]);
    assert.ok(handled.every((r) => r.handled_by === "admin:e2e-admin" && r.reporter == null));

    // Two handled groups (one per Mark handled); Reopen on the latest puts back only that report.
    await a.locator("[data-problem-handled] summary").click();
    const groups = a.locator(`[data-problem-handled-site="${SITE}"]`);
    assert.equal(await groups.count(), 2);
    await groups.first().locator("[data-problem-reopen]").click();
    await a.locator(`[data-problem-site="${SITE}"]`).waitFor();
    assert.equal((await a.locator(`[data-problem-site="${SITE}"] [data-problem-count]`).textContent()).trim(), "1 report");
    assert.deepEqual((await reportsOn(SITE)).map((r) => r.status), ["open", "handled"]);
  } finally {
    await browser.close();
  }
  assert.equal(await rating(SITE), before, "a report changes nothing about the site's rating");
});

test("Cloudflare's checkbox: the panel says to tick it, sends nothing without the token, then sends with it", async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  try {
    const ctx = await context(browser, { viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    // A stand-in for Turnstile that asks for a tick and gives its token only when the test ticks
    // (components/ui/Turnstile.tsx uses an existing window.turnstile instead of loading Cloudflare's script).
    await p.addInitScript(() => {
      window.__resets = 0;
      window.turnstile = {
        render(el, opts) {
          el.textContent = "Verify you are human";
          setTimeout(() => opts["before-interactive-callback"]?.(), 50);
          window.__tick = () => opts.callback("ticked-token");
          return "w1";
        },
        reset() {
          window.__resets++;
        },
        remove() {},
      };
    });
    const posts = [];
    await p.route("**/api/problem-reports", (route) => {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await p.goto(profile(TICK));
    await p.locator("[data-report-open]").click();
    const dialog = p.getByRole("dialog", { name: "Report a problem" });
    await dialog.getByLabel("The screenshot is wrong or broken").check();
    await dialog.locator("[data-report-send]").click();
    await dialog.locator("[data-report-tick]").getByText(/tick the box and your report sends/).waitFor();
    // Past the few seconds an invisible check gets, nothing was sent, no error shown, and the challenge was left alone.
    await p.waitForTimeout(6000);
    assert.equal(posts.length, 0);
    assert.equal(await dialog.locator("[data-report-error]").count(), 0);
    assert.equal(await p.evaluate(() => window.__resets), 0, "the widget is not reset mid-challenge");
    await p.evaluate(() => window.__tick());
    await p.getByRole("dialog", { name: "Thanks for telling us" }).waitFor();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].turnstileToken, "ticked-token");
  } finally {
    await browser.close();
  }
});

test("offline: the panel says it couldn't reach the site, keeps the report, and sends it once back", async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  try {
    const ctx = await context(browser, { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(profile(TICK));
    await p.locator("[data-report-open]").click();
    const dialog = p.getByRole("dialog", { name: "Report a problem" });
    await dialog.getByLabel("The site is gone or has changed").check();
    await dialog.locator("[data-report-note]").fill("Redirects to a parked page.");
    await p.route("**/api/problem-reports", (route) => route.abort("internetdisconnected"));
    await dialog.locator("[data-report-send]").click();
    await dialog.locator("[data-report-error]").getByText(/couldn't reach PortfolioRank/).waitFor();
    assert.equal(await dialog.locator("[data-report-note]").inputValue(), "Redirects to a parked page.");
    assert.equal(await dialog.locator("[data-report-send]").isEnabled(), true);
    await p.unroute("**/api/problem-reports");
    await dialog.locator("[data-report-send]").click();
    await p.getByRole("dialog", { name: "Thanks for telling us" }).waitFor();
    const rows = await reportsOn(TICK);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, "Redirects to a parked page.");
  } finally {
    await browser.close();
  }
});
