// The admin pages share one layout (app/admin/layout.tsx and
// app/admin/(tools)/layout.tsx), end to end against the running production
// build (scripts/test-e2e.sh): the same admin nav, container width and page
// header on every tool page, at desktop and phone widths, with no sideways
// scroll; the overview at /admin links every tool page with its headline
// numbers; and the image library shows images first: its tabs and grid are on
// the first screen and a thumbnail opens the large view, which Back closes.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { insertImage } from "../lib/content/library.mjs";
import { readFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
// Every admin page in the nav (components/admin/AdminNav.tsx ADMIN_PAGES), plus the overview link.
const NAV_LINKS = (readFileSync("components/admin/AdminNav.tsx", "utf8").match(/\{ href: "\/admin\//g) ?? []).length + 1;
const PAGES = ["/admin", "/admin/usage", "/admin/limits", "/admin/images", "/admin/blog", "/admin/blog/guidelines", "/admin/polls", "/admin/review"];
const IMAGE = "e2e00000000000a7";

let cookie;
before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  cookie = await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
  // The admin API creates the library tables on first use.
  assert.equal((await fetch(`${BASE}/api/admin/library`, { headers: { cookie } })).status, 200);
  const db = createClient({ url: DB_URL, timeout: 10000 });
  await insertImage(db, { id: IMAGE, theme: "design-polish", key: `private/library/test/${IMAGE}.jpg`, tags: ["layout"], alt: "A layout test image", caption: "AI-generated illustration", source: "workers-ai", licence: "generated", credit: "AI-generated illustration", status: "approved", check: { note: "ok" } });
});

test("admin layout: one nav, container width and header on every tool page, no sideways scroll", async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const seen = new Set();
      for (const path of PAGES) {
        await page.goto(`${BASE}${path}`);
        await page.locator("[data-admin-header] h1").waitFor();
        const nav = page.getByRole("navigation", { name: "Admin" });
        assert.equal(await nav.getByRole("link").count(), NAV_LINKS, `${path}: the admin nav`);
        const section = path === "/admin" ? "Admin overview" : path.startsWith("/admin/blog") ? "Blog drafts" : path.split("/")[2].replace(/^./, (c) => c.toUpperCase());
        assert.ok(await nav.getByRole("link", { name: section }).getAttribute("aria-current"), `${path}: ${section} is marked current`);
        const box = await page.evaluate(() => {
          const r = (s) => document.querySelector(s)?.getBoundingClientRect();
          return { container: r("[data-admin-tools]")?.width, header: r("[data-admin-header]")?.left, h1: document.querySelectorAll("h1").length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.equal(box.h1, 1, `${path}: one h1`);
        assert.equal(box.overflow, 0, `${path}: no sideways scroll at ${width}px`);
        seen.add(`${box.container}:${box.header}`);
      }
      assert.equal(seen.size, 1, `every admin page has the same container and header position at ${width}px: ${[...seen].join(", ")}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("admin overview: a card for every tool page with its numbers; a card opens its page", async () => {
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      await page.goto(`${BASE}/admin`);
      const cards = page.locator("[data-admin-card]");
      assert.deepEqual(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-admin-card"))), ["/admin/usage", "/admin/images", "/admin/blog", "/admin/polls"]);
      const images = page.locator('[data-admin-card="/admin/images"]');
      const approved = Number(await images.locator("dt", { hasText: "approved" }).locator("xpath=following-sibling::dd").textContent());
      assert.ok(approved >= 1, `the approved count includes the test image (${approved})`);
      await page.locator('[data-admin-card="/admin/blog"]').getByRole("link", { name: "Editor's guidelines" }).waitFor();
      // The card itself is the link: a click anywhere on it opens the page.
      await images.click();
      await page.waitForURL(`${BASE}/admin/images`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("image library: tabs and thumbnails on the first screen; a thumbnail opens the large view, Back closes it", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { cookie } });
    const page = await context.newPage();
    await page.goto(`${BASE}/admin/images?view=approved`);
    await page.getByRole("tab", { name: /^Approved \(\d+\)$/, selected: true }).waitFor();
    const tile = page.locator(`[data-image="${IMAGE}"]`);
    const top = (await tile.boundingBox())?.y ?? Infinity;
    assert.ok(top < 900, `the first thumbnails are on the first screen (top ${top})`);
    await tile.getByRole("button", { name: /^Open: / }).click();
    const detail = page.locator(`[data-image-detail="${IMAGE}"]`);
    await detail.waitFor();
    assert.match(page.url(), new RegExp(`image=${IMAGE}`));
    assert.equal(await detail.getByText("A layout test image").count(), 1, "alt text in the large view");
    await detail.getByRole("button", { name: "Edit alt and tags" }).waitFor();
    await detail.getByRole("button", { name: /^Retire/ }).waitFor();
    await page.goBack();
    await detail.waitFor({ state: "detached" });
    assert.doesNotMatch(page.url(), /image=/);
    await context.close();
  } finally {
    await browser.close();
  }
});
