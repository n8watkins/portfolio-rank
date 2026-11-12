// The blog newsletter end to end against the production build
// (scripts/test-e2e.sh: NEWSLETTER_ENABLED on, emails land in email_outbox):
// the sign-up's guards and rate limits, the confirm email and its one-click
// page, unsubscribing from the page and by one-click POST, the admin's
// Newsletter page and its test email, and the forms in a real browser on a
// post (sidebar on desktop, after the post on a phone), on /blog and in the
// footer.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { AI_LINE, storePost } from "../lib/content/store.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
const RUN = Math.random().toString(36).slice(2, 8);
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/blog/posts.json", import.meta.url), "utf8"))[0];
let ipSeq = 10;
let browser;
let post;

const subscribe = (body, { ip = `203.0.113.${ipSeq++}`, origin = BASE } = {}) =>
  fetch(`${BASE}/api/newsletter/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

/** The newest email of `kind` to `to`, from the outbox. */
async function mailTo(to, kind) {
  const r = (await db.execute({ sql: "SELECT subject, text, html, headers FROM email_outbox WHERE kind = ? AND to_addr = ? ORDER BY id DESC LIMIT 1", args: [kind, to] })).rows[0];
  assert.ok(r, `a ${kind} email went to ${to}`);
  return { subject: String(r.subject), text: String(r.text), html: String(r.html ?? ""), headers: r.headers ? JSON.parse(String(r.headers)) : null };
}

async function confirmLink(to) {
  const m = (await mailTo(to, "newsletter-confirm")).text.match(/https?:\/\/\S+\/newsletter\/confirm\?t=([A-Za-z0-9_-]{43})/);
  assert.ok(m, "a confirm link was sent");
  return { url: m[0], token: m[1] };
}

const status = async (email) => (await db.execute({ sql: "SELECT status, source FROM newsletter_subscribers WHERE email = ?", args: [email] })).rows[0];

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const id = crypto.randomBytes(8).toString("hex");
  post = { ...fixture, id, slug: `e2e-newsletter-${id}`, status: "published", aiLine: AI_LINE, aiNote: "note" };
  await storePost(db, post, { mode: "dry-run", publishAt: Date.now() - 60000, now: Date.now() - 120000 });
  await db.execute({ sql: "UPDATE posts SET publish_at = ? WHERE id = ?", args: [new Date(Date.now() - 60000).toISOString(), id] });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

test("sign-up: this site's Origin and a real address only, the same answer for everyone, and a confirm email", async () => {
  const email = `ada-${RUN}@example.com`;
  assert.equal((await subscribe({ email }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await subscribe({ email }, { origin: null })).status, 403);
  const bad = await subscribe({ email: "not an address" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_email");

  const ok = await subscribe({ email: `Ada-${RUN}@Example.com`, source: "/blog/x?utm=1", form: "sidebar" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.deepEqual({ ...(await status(email)) }, { status: "pending", source: "/blog/x (sidebar)" });
  const mail = await mailTo(email, "newsletter-confirm");
  assert.equal(mail.subject, "Confirm your PortfolioRank subscription");
  assert.match(mail.html, /Confirm my subscription/);
  assert.ok(!/—/.test(mail.text + mail.html), "no em dashes");
});

test("confirm: the link's page confirms only with its button, once", async () => {
  const email = `bob-${RUN}@example.com`;
  assert.equal((await subscribe({ email, source: "/blog", form: "blog" })).status, 200);
  const { url, token } = await confirmLink(email);

  // A mail scanner's GET reads the page but confirms nothing.
  const scan = await fetch(url);
  assert.equal(scan.status, 200);
  assert.match(await scan.text(), /bo\*\*\*@example\.com/);
  assert.equal((await status(email)).status, "pending");

  const p = await browser.newPage();
  await p.goto(url);
  await p.getByRole("button", { name: "Confirm my subscription" }).click();
  await p.getByText("You're subscribed.").waitFor();
  await p.close();
  assert.equal((await status(email)).status, "confirmed");

  const again = await fetch(`${BASE}/api/newsletter/confirm`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ t: token }) });
  assert.equal(again.status, 400, "a link works once");
  assert.match(await (await fetch(url)).text(), /This confirm link doesn.t work/);

  // Signing up again while confirmed sends nothing and says the same.
  const before = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ?", args: [email] })).rows[0].n;
  assert.deepEqual(await (await subscribe({ email })).json(), { ok: true });
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ?", args: [email] })).rows[0].n, before);
});

test("rate limits: 3 sign-ups a day per address, 10 an hour per network", async () => {
  const email = `busy-${RUN}@example.com`;
  for (let i = 0; i < 3; i++) assert.equal((await subscribe({ email })).status, 200);
  const over = await subscribe({ email });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);

  const ip = `198.18.0.${Math.floor(Math.random() * 200) + 20}`;
  for (let i = 0; i < 10; i++) assert.equal((await subscribe({ email: `net-${RUN}-${i}@example.com` }, { ip })).status, 200);
  assert.equal((await subscribe({ email: `net-${RUN}-x@example.com` }, { ip })).status, 429);
});

test("unsubscribe: the admin's test email has the headers; a subscriber leaves by page or by one-click POST", async () => {
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  assert.equal((await fetch(`${BASE}/api/admin/newsletter/test`, { method: "POST", headers: { "content-type": "application/json", origin: BASE } })).status, 401);
  const sent = await fetch(`${BASE}/api/admin/newsletter/test`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: "{}" });
  assert.equal(sent.status, 200, await sent.clone().text());
  const body = await sent.json();
  assert.equal(body.ok, true);
  const testMail = await mailTo(process.env.OWNER_EMAIL, "newsletter");
  assert.match(testMail.subject, /^\[Test\] /);
  assert.deepEqual(testMail.headers, { "List-Unsubscribe": `<${BASE}/newsletter/unsubscribe?test=1>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.match(testMail.text, /Read it: https?:\/\/\S+\/blog\//);

  // Real links: the subscriber id and its key (lib/newsletter/send.mjs unsubscribeUrl).
  const { unsubKey } = await import("../lib/newsletter/store.mjs");
  const email = `leave-${RUN}@example.com`;
  await subscribe({ email });
  await fetch(`${BASE}/api/newsletter/confirm`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ t: (await confirmLink(email)).token }) });
  const id = String((await db.execute({ sql: "SELECT id FROM newsletter_subscribers WHERE email = ?", args: [email] })).rows[0].id);
  const link = `${BASE}/api/newsletter/unsubscribe?s=${id}&k=${unsubKey(id, process.env.AUTH_SECRET)}`;

  // Opening the link in a browser shows a button; the GET changes nothing.
  const p = await browser.newPage();
  await p.goto(link);
  assert.match(p.url(), /\/newsletter\/unsubscribe\?s=/);
  assert.equal((await status(email)).status, "confirmed");
  await p.getByRole("button", { name: "Unsubscribe" }).click();
  await p.getByText("You're unsubscribed.").waitFor();
  await p.close();
  assert.equal((await status(email)).status, "unsubscribed");

  // A mail app's one-click unsubscribe: a form POST from the provider, no Origin.
  const email2 = `oneclick-${RUN}@example.com`;
  await subscribe({ email: email2 });
  await fetch(`${BASE}/api/newsletter/confirm`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ t: (await confirmLink(email2)).token }) });
  const id2 = String((await db.execute({ sql: "SELECT id FROM newsletter_subscribers WHERE email = ?", args: [email2] })).rows[0].id);
  const forged = await fetch(`${BASE}/api/newsletter/unsubscribe?s=${id2}&k=${"x".repeat(32)}`, { method: "POST", body: "List-Unsubscribe=One-Click" });
  assert.equal(forged.status, 400);
  const one = await fetch(`${BASE}/api/newsletter/unsubscribe?s=${id2}&k=${unsubKey(id2, process.env.AUTH_SECRET)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(one.status, 200);
  assert.equal((await status(email2)).status, "unsubscribed");
});

test("admin: the Newsletter page shows counts, who signed up and where; anyone else gets a 404", async () => {
  assert.equal((await fetch(`${BASE}/admin/blog/newsletter`)).status, 404);
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  const res = await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`bob-${RUN}@example.com`));
  assert.ok(html.includes("/blog (blog)"));
  assert.match(html, /Send test to me/);
  assert.match(html, /Recent sends/);
  const drafts = await (await fetch(`${BASE}/admin/blog`, { headers: { cookie } })).text();
  assert.match(drafts, /href="\/admin\/blog\/newsletter"/);
});

test("the forms: beside a post on desktop, after it on a phone, on /blog and in the footer elsewhere", async () => {
  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  desk.on("pageerror", (e) => errors.push(String(e)));
  await desk.goto(`${BASE}/blog/${post.slug}`);
  const side = desk.locator('[data-newsletter="sidebar"]');
  const after = desk.locator('[data-newsletter="after-post"]');
  await side.waitFor();
  assert.ok(await side.isVisible());
  assert.ok(!(await after.isVisible()));
  assert.equal(await desk.locator('[data-newsletter="footer"]').count(), 0, "no second form in the footer of a post");
  // The sidebar sits in the margin, right of the reading column, inside the window.
  const box = await side.boundingBox();
  const col = await desk.locator("article .prose, article [class*='max-w-[42rem]']").last().boundingBox();
  assert.ok(box.x >= col.x + col.width, "right of the column");
  assert.ok(box.x + box.width <= 1440, "inside the window");
  assert.equal(await desk.evaluate(() => document.documentElement.scrollWidth), 1440, "no sideways scroll");

  // Signing up from the sidebar.
  const email = `side-${RUN}@example.com`;
  await side.getByLabel("Email for new posts").fill(email);
  await side.getByRole("button", { name: "Subscribe" }).click();
  await side.getByText("check your inbox and press Confirm").waitFor();
  assert.deepEqual({ ...(await status(email)) }, { status: "pending", source: `/blog/${post.slug} (sidebar)` });

  await desk.goto(`${BASE}/blog`);
  await desk.locator('[data-newsletter="blog"]').waitFor();
  await desk.goto(`${BASE}/top`);
  await desk.locator('[data-newsletter="footer"]').waitFor();
  await desk.goto(`${BASE}/newsletter/unsubscribe`);
  await desk.getByRole("heading", { level: 1 }).waitFor();
  assert.equal(await desk.locator('[data-newsletter="footer"]').count(), 0, "none on the newsletter's own pages");
  await desk.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(`${BASE}/blog/${post.slug}`);
  await phone.locator('[data-newsletter="after-post"]').waitFor();
  assert.ok(await phone.locator('[data-newsletter="after-post"]').isVisible());
  assert.ok(!(await phone.locator('[data-newsletter="sidebar"]').isVisible()));
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scroll");
  await phone.close();
  assert.deepEqual(errors, []);
});
