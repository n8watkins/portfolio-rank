// The admin's test owner alert (POST /api/admin/alerts/test), end to end
// against the running production build (scripts/test-e2e.sh): only the
// admin, only from the site's own pages, and it says plainly what is missing
// when owner alerts can't be sent. The e2e server has no OWNER_EMAIL, so the
// sending itself is covered by pipeline/alerts.mjs emailSender's tests.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

const post = (cookie, { origin = BASE } = {}) =>
  fetch(`${BASE}/api/admin/alerts/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: "{}",
  });

test("test alert: signed out is 401, another account is 403, another site is refused", async () => {
  assert.equal((await post()).status, 401);
  const other = await post(await sessionCookie({ id: ADMIN_ID + 1, login: "e2e-admin" }));
  assert.equal(other.status, 403);
  const admin = await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" });
  assert.equal((await post(admin, { origin: "https://evil.example" })).status, 403);
});

test("test alert: without OWNER_EMAIL it names what is missing and sends nothing", async () => {
  const r = await post(await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const body = await r.json();
  assert.equal(body.error, "no_sender");
  assert.ok(body.missing.includes("OWNER_EMAIL"), JSON.stringify(body));
});

test("alerts page: the admin sees the email setup and the Send test alert button; anyone else gets a 404", async () => {
  const page = (cookie) => fetch(`${BASE}/admin/alerts`, { headers: cookie ? { cookie } : {} });
  assert.equal((await page()).status, 404);
  assert.equal((await page(await sessionCookie({ id: ADMIN_ID + 1, login: "someone" }))).status, 404);
  const r = await page(await sessionCookie({ id: ADMIN_ID, login: "e2e-admin" }));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Send test alert/);
  assert.match(html, /not set \(OWNER_EMAIL\)/);
});
