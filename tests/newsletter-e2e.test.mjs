// The blog newsletter end to end against the production build
// (scripts/test-e2e.sh: NEWSLETTER_ENABLED on, Kit's API replaced by the
// stand-in this file serves on E2E_KIT_PORT): the owner's switch (off by
// default: no forms, 404; on; off again), the sign-up's guards and rate
// limits, the address handed to Kit (an unconfirmed subscriber added to the
// one double opt-in form) and never stored by us, Kit being down, the
// admin's Newsletter page with Kit's count and the email preview, and the
// forms in a real browser on a post (sidebar on desktop, after the post on a
// phone), on /blog and in the footer.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { AI_LINE, storePost } from "../lib/content/store.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const KIT_PORT = Number(process.env.E2E_KIT_PORT ?? 7695);
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
const RUN = Math.random().toString(36).slice(2, 8);
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/blog/posts.json", import.meta.url), "utf8"))[0];
let ipSeq = 10;
let browser;
let post;

// The Kit stand-in: records each call; `kitDown` makes every call a 503.
const kitCalls = [];
let kitDown = false;
const kitServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://kit");
    const body = raw ? JSON.parse(raw) : null;
    kitCalls.push({ method: req.method, path: u.pathname.replace(/^\/v4/, ""), query: Object.fromEntries(u.searchParams), body, key: req.headers["x-kit-api-key"] });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (kitDown) return send(503, { errors: ["Service unavailable"] });
    const path = u.pathname.replace(/^\/v4/, "");
    if (req.method === "POST" && path === "/subscribers") return send(201, { subscriber: { id: 1, email_address: body.email_address, state: body.state } });
    if (req.method === "POST" && /^\/forms\/\d+\/subscribers$/.test(path)) return send(201, { subscriber: { id: 1, state: "inactive" } });
    if (req.method === "GET" && path === "/forms") return send(200, { forms: [{ id: 4242, name: "Blog" }], pagination: {} });
    if (req.method === "GET" && path === "/subscribers") return send(200, { subscribers: [], pagination: { has_next_page: false, total_count: 37 } });
    if (req.method === "GET" && path === "/account") return send(200, { user: { email: "owner@example.com" }, account: { name: "PortfolioRank", plan_type: "creator_free", primary_email_address: "hello@portfoliorank.dev" } });
    if (req.method === "GET" && path === "/email_templates") return send(200, { email_templates: [{ id: 1, name: "Text only", is_default: true }] });
    if (req.method === "GET" && path === "/broadcasts") return send(200, { broadcasts: [] });
    if (req.method === "POST" && path === "/broadcasts") return send(201, { broadcast: { id: 9001, subject: body.subject, send_at: body.send_at } });
    send(404, { errors: ["Not Found"] });
  });
});

const subscribe = (body, { ip = `203.0.113.${ipSeq++}`, origin = BASE } = {}) =>
  fetch(`${BASE}/api/newsletter/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

const kitAdds = (email) => kitCalls.filter((c) => c.method === "POST" && c.body?.email_address === email);

/** Every text column of every table, searched for an address: the database must never hold one. */
async function storedAnywhere(needle) {
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  for (const t of tables) {
    const cols = (await db.execute(`SELECT name, type FROM pragma_table_info('${t}')`)).rows.filter((c) => /TEXT|^$/i.test(String(c.type)));
    for (const c of cols) {
      const hit = (await db.execute({ sql: `SELECT 1 FROM "${t}" WHERE "${c.name}" LIKE ? LIMIT 1`, args: [`%${needle}%`] })).rows.length;
      if (hit) return `${t}.${c.name}`;
    }
  }
  return null;
}

before(async () => {
  await new Promise((r) => kitServer.listen(KIT_PORT, "127.0.0.1", r));
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
  await new Promise((r) => kitServer.close(r));
});

const setSwitch = async (on, cookie) =>
  fetch(`${BASE}/api/admin/newsletter/switch`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ on }) });

/** The post page in a browser at desktop width: how many sign-up forms show, once the status answer is in. */
async function formsOnPost() {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const status = p.waitForResponse((r) => r.url().endsWith("/api/newsletter/status"));
  await p.goto(`${BASE}/blog/${post.slug}`);
  const on = (await (await status).json()).on;
  await p.waitForTimeout(300);
  const n = await p.locator("[data-newsletter]").count();
  await p.close();
  return { on, n };
}

test("off by default: no forms, the sign-up answers 404; only the admin can turn it on, and that is logged", async () => {
  assert.deepEqual(await (await fetch(`${BASE}/api/newsletter/status`)).json(), { on: false });
  assert.equal((await subscribe({ email: `early-${RUN}@example.com` })).status, 404);
  assert.equal(kitAdds(`early-${RUN}@example.com`).length, 0);
  assert.deepEqual(await formsOnPost(), { on: false, n: 0 });

  assert.equal((await setSwitch(true)).status, 401, "signed out");
  assert.equal((await setSwitch(true, await sessionCookie({ id: ADMIN_ID + 1, login: "someone" }))).status, 403, "not the admin");
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  const page = await (await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } })).text();
  assert.match(page, /data-newsletter-switch="off"/);
  assert.match(page, /Turn newsletter on/);

  const res = await setSwitch(true, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.on, true);
  assert.equal(body.live, true);
  assert.deepEqual(body.log.map((c) => [c.on, c.by]), [[true, "admin"]]);
  assert.deepEqual(await (await fetch(`${BASE}/api/newsletter/status`)).json(), { on: true });
  assert.match(await (await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } })).text(), /Turn newsletter off/);
});

test("sign-up: this site's Origin and a real address only; Kit gets an unconfirmed subscriber on its one form, we keep no address", async () => {
  const email = `ada-${RUN}@example.com`;
  assert.equal((await subscribe({ email }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await subscribe({ email }, { origin: null })).status, 403);
  const bad = await subscribe({ email: "not an address" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_email");
  assert.equal(kitAdds(email).length, 0, "nothing reached Kit");

  const ok = await subscribe({ email: `Ada-${RUN}@Example.com`, source: "/blog/x?utm=1", form: "sidebar" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.deepEqual(
    kitAdds(email).map((c) => [c.path, c.body]),
    [
      ["/subscribers", { email_address: email, state: "inactive" }],
      ["/forms/4242/subscribers", { email_address: email, referrer: `${BASE}/blog/x` }],
    ],
    "the address, normalized, as unconfirmed, then onto the form whose double opt-in sends Kit's confirm email"
  );
  assert.ok(kitCalls.every((c) => c.key === "e2e-kit-key"));
  assert.equal(await storedAnywhere(`ada-${RUN}`), null, "no table holds the address");

  // Signing up again says the same; Kit decides whether anything is sent.
  assert.deepEqual(await (await subscribe({ email })).json(), { ok: true });
});

test("Kit down: the form says email is unavailable, and nothing is kept", async () => {
  kitDown = true;
  try {
    const email = `down-${RUN}@example.com`;
    const res = await subscribe({ email });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "email_unavailable");
    assert.equal(await storedAnywhere(`down-${RUN}`), null);
  } finally {
    kitDown = false;
  }
});

test("rate limits: 3 sign-ups a day per address, 10 an hour per network, before Kit is asked", async () => {
  const email = `busy-${RUN}@example.com`;
  for (let i = 0; i < 3; i++) assert.equal((await subscribe({ email })).status, 200);
  const over = await subscribe({ email });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal(kitAdds(email).length, 6, "three sign-ups, two calls each; the fourth never reached Kit");

  const ip = `198.18.0.${Math.floor(Math.random() * 200) + 20}`;
  for (let i = 0; i < 10; i++) assert.equal((await subscribe({ email: `net-${RUN}-${i}@example.com` }, { ip })).status, 200);
  assert.equal((await subscribe({ email: `net-${RUN}-x@example.com` }, { ip })).status, 429);
});

test("the removed self-sent pieces are gone", async () => {
  for (const p of ["/newsletter/confirm?t=x", "/newsletter/unsubscribe", "/api/newsletter/confirm", "/api/newsletter/unsubscribe"]) {
    assert.equal((await fetch(`${BASE}${p}`, { redirect: "manual" })).status, 404, p);
  }
});

test("admin: the Newsletter page shows Kit's count and setup, and previews the email; anyone else gets a 404", async () => {
  assert.equal((await fetch(`${BASE}/admin/blog/newsletter`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/admin/newsletter/preview`)).status, 401);
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  const res = await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Confirmed subscribers/);
  assert.match(html, />37</, "Kit's confirmed count");
  assert.match(html, /from Kit, just now/);
  assert.match(html, /Open Kit broadcasts/);
  assert.ok(!html.includes(`ada-${RUN}`), "no addresses on the page");

  const preview = await fetch(`${BASE}/api/admin/newsletter/preview`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /text\/html/);
  const mail = await preview.text();
  assert.match(mail, /New on the blog/);
  assert.match(mail, /Read the post/);
  assert.ok(!mail.includes("{{"), "Kit's tags replaced in the preview");

  const drafts = await (await fetch(`${BASE}/admin/blog`, { headers: { cookie } })).text();
  assert.match(drafts, /href="\/admin\/blog\/newsletter"/);
  // The overview reads the cached count, which the Newsletter page just refreshed
  // (an earlier test file may have opened /admin before the Kit stand-in was up).
  const overview = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
  assert.match(overview, /37 subscribers/);
});

test("admin: Test the newsletter (Kit) shows the setup check, says which system sends what, and makes a [test] draft sent to nobody", async () => {
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  const html = await (await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } })).text();
  assert.match(html, /Test the newsletter \(Kit\)/);
  assert.match(html, /Newsletters go through Kit/);
  assert.match(html, /Site alerts go through Cloudflare Email Service/);
  assert.match(html, /hello@portfoliorank\.dev/, "the sender from Kit's account");
  assert.match(html, /portfoliorank\.dev \(check Verified in Kit\)/);
  assert.match(html, /Blog \(4242\)/, "the sign-up form, by name and id");
  assert.match(html, /Create a test draft in Kit/);

  const draft = (cookie, origin = BASE) =>
    fetch(`${BASE}/api/admin/newsletter/test-draft`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: "{}" });
  assert.equal((await draft()).status, 401);
  assert.equal((await draft(await sessionCookie({ id: ADMIN_ID + 1, login: "someone" }))).status, 403);
  assert.equal((await draft(cookie, "https://evil.example")).status, 403);
  const before = kitCalls.filter((c) => c.method === "POST" && c.path === "/broadcasts").length;
  const res = await draft(cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.id, "9001");
  assert.equal(body.url, "https://app.kit.com/campaigns/9001/draft");
  assert.match(body.subject, /^\[test\] /);
  const made = kitCalls.filter((c) => c.method === "POST" && c.path === "/broadcasts");
  assert.equal(made.length, before + 1);
  const b = made.at(-1).body;
  assert.equal(b.send_at, null, "a draft: never scheduled, sent to nobody");
  assert.match(b.subject, /^\[test\] /);
  assert.match(b.description, /test draft .*sent to nobody/);
  assert.ok(b.content.includes("{{ unsubscribe_url }}"));
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
  assert.equal(kitAdds(email).find((c) => c.path.startsWith("/forms/"))?.body.referrer, `${BASE}/blog/${post.slug}`);

  await desk.goto(`${BASE}/blog`);
  await desk.locator('[data-newsletter="blog"]').waitFor();
  await desk.goto(`${BASE}/top`);
  await desk.locator('[data-newsletter="footer"]').waitFor();
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

test("turned off again: the forms disappear, the sign-up answers 404, and nothing reaches Kit", async () => {
  const cookie = await sessionCookie({ id: ADMIN_ID, login: "admin" });
  const res = await setSwitch(false, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).log.slice(0, 2).map((c) => c.on), [false, true]);
  assert.deepEqual(await (await fetch(`${BASE}/api/newsletter/status`)).json(), { on: false });
  const before = kitCalls.length;
  assert.equal((await subscribe({ email: `late-${RUN}@example.com` })).status, 404);
  assert.equal(kitCalls.length, before);
  assert.deepEqual(await formsOnPost(), { on: false, n: 0 });
  // The admin page still shows Kit and the switch, so the owner can turn it back on.
  const page = await (await fetch(`${BASE}/admin/blog/newsletter`, { headers: { cookie } })).text();
  assert.match(page, /Turn newsletter on/);
  assert.match(page, /Confirmed subscribers/);
});
