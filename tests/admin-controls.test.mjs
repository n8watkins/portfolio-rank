// The admin's controls end to end on the production build
// (scripts/test-e2e.sh: ADMIN_GITHUB_ID, CONTENT_MODE "dry-run" and
// CONTENT_DRAFTS_PER_WEEK 2, as in production): the "Admin" entry in the
// admin's own menus only, /admin itself, and the blog's Automation panel
// with its ceiling, saving, the topic queue and the next and last runs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
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

const admin = () => sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
const someone = () => sessionCookie({ id: 990000777, login: "someone-else" });

async function pageAs(cookie, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  if (cookie) {
    const [name, ...rest] = cookie.split("=");
    await context.addCookies([{ name, value: rest.join("="), url: BASE }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { page, context, errors };
}

const post = async (body, cookie) =>
  fetch(`${BASE}/api/admin/content/automation`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) });

test("/admin: the admin lands on the usage page; anyone else gets a 404", async () => {
  const res = await fetch(`${BASE}/admin`, { headers: { cookie: await admin() }, redirect: "manual" });
  assert.ok([303, 307, 308].includes(res.status), `redirect, got ${res.status}`);
  assert.match(res.headers.get("location") ?? "", /\/admin\/usage$/);
  assert.equal((await fetch(`${BASE}/admin`, { headers: { cookie: await someone() } })).status, 404);
  assert.equal((await fetch(`${BASE}/admin`)).status, 404);
  assert.equal((await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie: await admin() } })).json()).isAdmin, true);
  assert.equal((await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie: await someone() } })).json()).isAdmin, false);
});

test("the account menu and the phone menu show Admin to the admin only", async () => {
  for (const [who, cookie, shown] of [
    ["admin", await admin(), true],
    ["someone", await someone(), false],
  ]) {
    const desk = await pageAs(cookie);
    await desk.page.goto(`${BASE}/top`);
    await desk.page.getByRole("button", { name: /^Account: / }).click();
    const menu = desk.page.getByRole("menu", { name: "Account" });
    await menu.getByRole("menuitem", { name: "Sign out" }).waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Admin" }).count(), shown ? 1 : 0, `${who}, desktop`);
    if (shown) assert.equal(await menu.getByRole("menuitem", { name: "Admin" }).getAttribute("href"), "/admin/usage");
    assert.deepEqual(desk.errors, []);
    await desk.context.close();

    const phone = await pageAs(cookie, { width: 390, height: 844 });
    await phone.page.goto(`${BASE}/top`);
    await phone.page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "More" }).click();
    const sheet = phone.page.getByRole("dialog");
    await sheet.getByRole("link", { name: "Settings" }).waitFor();
    assert.equal(await sheet.getByRole("link", { name: "Admin" }).count(), shown ? 1 : 0, `${who}, phone`);
    await phone.context.close();
  }
});

test("automation API: admin only, and the page can never go above the config's ceiling", async () => {
  assert.equal((await post({ op: "save", settings: { enabled: true, mode: "review", days: [1], perWeek: 1 } }, await someone())).status, 403);
  const cookie = await admin();
  const publish = await post({ op: "save", settings: { enabled: true, mode: "publish", days: [1, 3], perWeek: 2 } }, cookie);
  assert.equal(publish.status, 400);
  assert.match((await publish.json()).message, /CONTENT_MODE/);
  const many = await post({ op: "save", settings: { enabled: true, mode: "review", days: [1, 3, 5], perWeek: 3 } }, cookie);
  assert.equal(many.status, 400);
  assert.match((await many.json()).message, /At most 2/);
  const view = await (await fetch(`${BASE}/api/admin/content/automation`, { headers: { cookie } })).json();
  assert.deepEqual(view.bounds, { maxMode: "dry-run", maxPerWeek: 2, canPublish: false, canRun: true });
});

test("the Automation panel: save the nights and drafts a week, queue a topic, see the next and last runs", async () => {
  await db.execute("DELETE FROM content_settings");
  await db.execute("DELETE FROM content_topics");
  const { page: p, context, errors } = await pageAs(await admin());
  await p.goto(`${BASE}/admin/blog`);
  const panel = p.getByRole("region", { name: "Automation" });
  await panel.getByText("On: 2 drafts a week on Monday and Wednesday nights, for your review").waitFor();
  assert.equal(await panel.getByRole("radio", { name: /Publish automatically/ }).isDisabled(), true, "the config keeps publishing off");
  await panel.getByText(/Needs CONTENT_MODE "publish"/).waitFor();

  await panel.getByRole("button", { name: "Wednesday" }).click();
  await panel.getByRole("button", { name: "Thursday" }).click();
  await panel.getByRole("radio", { name: "1" }).click();
  await panel.getByRole("button", { name: "Save automation" }).click();
  await panel.getByText("Saved. It applies from tonight's run.").waitFor();
  await panel.getByText("On: 1 draft a week on Monday and Thursday nights, for your review").waitFor();
  const stored = JSON.parse(String((await db.execute("SELECT v FROM content_settings WHERE k = 'automation'")).rows[0].v));
  assert.deepEqual(stored, { enabled: true, mode: "review", days: [1, 4], perWeek: 1 });

  await panel.getByRole("textbox", { name: "New topic" }).fill("Why a resume link beats a contact form");
  await panel.getByRole("button", { name: "Add topic" }).click();
  await panel.getByRole("listitem").filter({ hasText: "Why a resume link beats a contact form" }).waitFor();
  await panel.getByText(/Next run/).waitFor();
  assert.match(await panel.textContent(), /on "Why a resume link beats a contact form"/);
  assert.match(await panel.textContent(), /Last run.*(None yet|night)/s);
  await panel.getByRole("button", { name: 'Remove "Why a resume link beats a contact form"' }).click();
  await panel.getByText("No topics queued").waitFor();

  // Off, then back to the defaults for other tests.
  await panel.getByRole("switch", { name: "Scheduled drafts" }).click();
  await panel.getByRole("button", { name: "Save automation" }).click();
  await panel.getByText(/^Off$/).waitFor();
  await p.reload();
  await p.getByRole("region", { name: "Automation" }).getByText(/^Off$/).waitFor();
  await db.execute("DELETE FROM content_settings");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the Automation panel fits a phone", async () => {
  const { page: p, context } = await pageAs(await admin(), { width: 390, height: 844 });
  await p.goto(`${BASE}/admin/blog`);
  await p.getByRole("region", { name: "Automation" }).waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0);
  await context.close();
});
