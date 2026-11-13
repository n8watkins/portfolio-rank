// Email sign-in end to end against the production build (scripts/test-e2e.sh,
// emails land in email_outbox): the request's guards, the one-time link, the
// one-click landing page, the signed-in session, single use, the caps, the
// account's data and its deletion, and the dialog in a real browser.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createClient } from "@libsql/client";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
const RUN = Math.random().toString(36).slice(2, 8);
let ipSeq = 10;
let browser;

const request = (body, { ip = `198.51.100.${ipSeq++}`, origin = BASE } = {}) =>
  fetch(`${BASE}/api/signin/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

/** The newest sign-in link sent to `to`, from the outbox. */
async function linkFor(to) {
  const r = (await db.execute({ sql: "SELECT text FROM email_outbox WHERE kind = 'signin' AND to_addr = ? ORDER BY id DESC LIMIT 1", args: [to] })).rows[0];
  const m = String(r?.text ?? "").match(/https?:\/\/\S+\/signin\/email\?t=([A-Za-z0-9_-]{43})/);
  assert.ok(m, "a sign-in link was sent");
  return { url: m[0], token: m[1] };
}

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

test("request: this site's Origin and a real address only; the answer says nothing more", async () => {
  assert.equal((await request({ email: `a-${RUN}@example.com` }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await request({ email: `a-${RUN}@example.com` }, { origin: null })).status, 403);
  const bad = await request({ email: "not an address" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_email");
  const ok = await request({ email: `New-${RUN}@Example.com`, callbackUrl: "https://evil.example/x" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { sent: true });
  // Stored lower case; only the token's hash is kept.
  const row = (await db.execute({ sql: "SELECT token_hash, email, callback FROM email_signin_tokens WHERE email = ?", args: [`new-${RUN}@example.com`] })).rows[0];
  assert.ok(row);
  assert.equal(row.callback, null, "a foreign callback is dropped");
  const { token } = await linkFor(`new-${RUN}@example.com`);
  assert.notEqual(row.token_hash, token);
});

test("the link: one click signs in as an email account, back where you were, and works once", async () => {
  const email = `reader-${RUN}@example.com`;
  assert.equal((await request({ email, callbackUrl: "/top" })).status, 200);
  const { url } = await linkFor(email);

  // A mail scanner's GET reads the page but uses nothing.
  const scan = await fetch(url);
  assert.equal(scan.status, 200);
  assert.match(await scan.text(), /re\*\*\*@example\.com/);

  const context = await browser.newContext();
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  await p.getByRole("heading", { name: "Sign in to PortfolioRank" }).waitFor();
  await p.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
  await p.waitForURL(/\/top$/);
  const session = await (await p.request.get(`${BASE}/api/auth/session`)).json();
  assert.equal(session.login, email);
  assert.equal(session.provider, "email");
  assert.match(session.raterId, /^em:[A-Za-z0-9_-]{16}$/);
  // A vote from an email account counts: the face-off sees a signed-in rater.
  const rank = await (await p.request.get(`${BASE}/api/rank`)).json();
  assert.equal(rank.rater.signedIn, true);

  // The same link again: used.
  const again = await browser.newContext();
  const q = await again.newPage();
  await q.goto(url);
  await q.getByRole("heading", { name: "This sign-in link doesn't work" }).waitFor();
  await q.getByText("already used").waitFor();
  assert.deepEqual(errors, []);
  await again.close();

  // Signing in again later finds the same account.
  assert.equal((await request({ email })).status, 200);
  const second = await linkFor(email);
  const c2 = await browser.newContext();
  const r = await c2.newPage();
  await r.goto(second.url);
  await r.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
  await r.waitForURL(`${BASE}/`);
  assert.equal((await (await r.request.get(`${BASE}/api/auth/session`)).json()).raterId, session.raterId);
  await c2.close();

  // The account's data, then its deletion by typing the address.
  const data = await (await p.request.get(`${BASE}/api/account`)).json();
  assert.equal(data.tables.email_accounts?.[0]?.email, email);
  const del = await p.request.delete(`${BASE}/api/account`, { headers: { origin: BASE, "content-type": "application/json" }, data: { confirm: email } });
  assert.equal(del.status(), 200);
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM email_accounts WHERE email = ?", args: [email] })).rows[0].n, 0);
  await context.close();
});

test("an expired or unknown link says so and offers a new one", async () => {
  const email = `late-${RUN}@example.com`;
  assert.equal((await request({ email })).status, 200);
  const { url, token } = await linkFor(email);
  await db.execute({ sql: "UPDATE email_signin_tokens SET expires_at = ? WHERE email = ?", args: ["2000-01-01T00:00:00.000Z", email] });
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(url);
  await p.getByText("ran out").waitFor();
  await p.goto(`${BASE}/signin/email?t=${token.slice(0, 20)}`);
  await p.getByText("isn't one we sent").waitFor();
  await p.getByRole("button", { name: "Send a new link" }).click();
  await p.getByRole("dialog").getByRole("button", { name: "Email me a sign-in link" }).waitFor();
  await context.close();
});

test("caps: 3 links an hour per address, then 429; other addresses are unaffected", async () => {
  const email = `busy-${RUN}@example.com`;
  for (let i = 0; i < 3; i++) assert.equal((await request({ email })).status, 200);
  const over = await request({ email });
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, "rate_limited");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  assert.equal((await request({ email: `other-${RUN}@example.com` })).status, 200);
});

test("caps: 10 requests an hour per network, whatever the address", async () => {
  const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
  for (let i = 0; i < 10; i++) assert.equal((await request({ email: `n${i}-${RUN}@example.com` }, { ip })).status, 200);
  assert.equal((await request({ email: `n10-${RUN}@example.com` }, { ip })).status, 429);
});

test("the dialog: GitHub or an email link; sent shows the address and a way back", async () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { "cf-connecting-ip": `192.0.2.${200 + (ipSeq++ % 50)}` } });
    const p = await context.newPage();
    await p.goto(`${BASE}/?signin=1`);
    const dialog = p.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue with GitHub" }).waitFor();
    const field = dialog.getByRole("textbox", { name: "Email address" });
    await dialog.getByRole("button", { name: "Email me a sign-in link" }).click();
    await dialog.getByRole("alert").filter({ hasText: "like you@example.com" }).waitFor();
    await field.fill(`dialog-${width}-${RUN}@example.com`);
    await dialog.getByRole("button", { name: "Email me a sign-in link" }).click();
    await dialog.getByText("Check your email").waitFor();
    await dialog.getByText(`dialog-${width}-${RUN}@example.com`).waitFor();
    await dialog.getByRole("button", { name: "Use a different email" }).click();
    await field.waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    await context.close();
  }
});
