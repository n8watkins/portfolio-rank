// The image library's review (/admin/images and /api/admin/library), end to
// end against the running production build (scripts/test-e2e.sh, which sets
// ADMIN_GITHUB_ID): only that account sees the page and may
// decide; every decision is a POST from this site with a JSON body (CSRF);
// keep, drop and retire move only the statuses they apply to; the manual
// batch runs only in production.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { insertImage } from "../lib/content/library.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

const cookieFor = (login, id) => sessionCookie({ id, login });

let admin;
let other;
// A pending image and one the Gemini check rejected (16 hex digits, like real ids).
const ids = ["e2e0000000000001", "e2e0000000000002"];

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  // The admin API creates the tables on first use.
  admin = await cookieFor("e2e-admin", ADMIN_ID);
  other = await cookieFor("someone-else", 990000102);
  const res = await fetch(`${BASE}/api/admin/library`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const row = (id, status) => ({ id, theme: "design-polish", subjectIndex: null, key: `private/library/test/${id}.jpg`, tags: ["design"], alt: "A test image", caption: "AI-generated illustration", source: "workers-ai", licence: "generated", credit: "AI-generated illustration", status, check: { note: "fake letters" } });
  await insertImage(db, row(ids[0], "pending"));
  await insertImage(db, row(ids[1], "rejected-auto"));
});

const post = (path, body, { cookie, origin = BASE, type = "application/json" } = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("library API: signed out is 401, any other login is 403, never cached", async () => {
  const anon = await fetch(`${BASE}/api/admin/library`);
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("cache-control"), "private, no-store");
  assert.equal((await fetch(`${BASE}/api/admin/library`, { headers: { cookie: other } })).status, 403);
  const ok = await fetch(`${BASE}/api/admin/library`, { headers: { cookie: admin } });
  const body = await ok.json();
  assert.equal(body.summary.subjects, 130);
  assert.ok(body.images.some((i) => i.id === ids[0] && i.status === "pending"));
});

test("library API: POSTs need this site's Origin and a JSON body (CSRF), and the admin", async () => {
  const keep = { id: ids[0], action: "keep" };
  assert.equal((await post("/api/admin/library", keep, { cookie: admin, origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/admin/library", keep, { cookie: admin, origin: null })).status, 403);
  assert.equal((await post("/api/admin/library", `id=${ids[0]}&action=keep`, { cookie: admin, type: "application/x-www-form-urlencoded" })).status, 400);
  assert.equal((await post("/api/admin/library", keep, { cookie: other })).status, 403);
  assert.equal((await post("/api/admin/library", keep)).status, 401);
  // Nothing changed.
  const row = (await db.execute({ sql: "SELECT status FROM image_library WHERE id = ?", args: [ids[0]] })).rows[0];
  assert.equal(row.status, "pending");
});

test("library API: keep, drop and retire, each only from the statuses it applies to", async () => {
  const kept = await post("/api/admin/library", { id: ids[0], action: "keep" }, { cookie: admin });
  assert.equal(kept.status, 200);
  const k = (await kept.json()).image;
  assert.equal(k.status, "approved");
  assert.equal(k.decidedBy, "admin:e2e-admin");
  assert.equal((await post("/api/admin/library", { id: ids[0], action: "drop" }, { cookie: admin })).status, 409);
  assert.equal((await post("/api/admin/library", { id: ids[1], action: "drop" }, { cookie: admin })).status, 200);
  assert.equal((await post("/api/admin/library", { id: ids[0], action: "retire" }, { cookie: admin })).status, 200);
  assert.equal((await post("/api/admin/library", { id: "ffffffffffffffff", action: "keep" }, { cookie: admin })).status, 404);
  assert.equal((await post("/api/admin/library", { id: ids[0], action: "publish" }, { cookie: admin })).status, 400);
  assert.equal((await post("/api/admin/library", { id: "../x", action: "keep" }, { cookie: admin })).status, 400);
});

test("manual batch: admin and CSRF checked; refused outside production", async () => {
  assert.equal((await post("/api/admin/library/generate", { count: 1 }, { cookie: admin, origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/admin/library/generate", { count: 1 }, { cookie: other })).status, 403);
  assert.equal((await post("/api/admin/library/generate", { count: 3 }, { cookie: admin })).status, 400);
  const r = await post("/api/admin/library/generate", { count: 1 }, { cookie: admin });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "production_only" });
});

test("review page: only the admin sees it; images are served to the admin only", async () => {
  assert.equal((await fetch(`${BASE}/admin/images`)).status, 404);
  assert.equal((await fetch(`${BASE}/admin/images`, { headers: { cookie: other } })).status, 404);
  const page = await fetch(`${BASE}/admin/images`, { headers: { cookie: admin } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Image library/);
  assert.match(html, /Make 2 now/);
  assert.match(html, /AI images today: (<!-- -->)?0(<!-- -->)? of (<!-- -->)?40/);
  assert.equal((await fetch(`${BASE}/api/admin/library/${ids[0]}/image`)).status, 401);
  // The admin may ask; the test server has no bucket, so the bytes are not there.
  assert.equal((await fetch(`${BASE}/api/admin/library/${ids[0]}/image`, { headers: { cookie: admin } })).status, 404);
});
