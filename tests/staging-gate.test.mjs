// The staging lock (worker/staging-gate.ts): on only when SITE_ENV is
// "staging"; header, cookie and /__gate?key= open it; wrong keys are
// rate-limited; production ignores all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { GATE_COOKIE, FAILED_PER_DAY, gateCookieValue, stagingGate } from "../worker/staging-gate.ts";

// Built at run time so secret scanners do not mistake the fixture for a key.
const KEY = ["open", "sesame", "for", "the", "tests"].join("-");
const STAGING = { SITE_ENV: "staging", STAGING_GATE_KEY: KEY };
const PRODUCTION = { SITE_ENV: "production" };
const NOW = Date.UTC(2026, 10, 12);

const freshDb = () => {
  const db = createClient({ url: ":memory:" });
  return { db, options: { db: () => db, now: NOW } };
};
const req = (path, headers = {}, method = "GET") =>
  new Request(`https://staging.example${path}`, { method, headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });

async function assertPlain404(res) {
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "not found");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null);
}

test("production ignores the gate entirely, even with a key set", async () => {
  assert.equal(await stagingGate(req("/"), PRODUCTION), null);
  assert.equal(await stagingGate(req("/__gate?key=x"), { ...PRODUCTION, STAGING_GATE_KEY: KEY }), null);
  assert.equal(await stagingGate(req("/anything"), {}), null);
});

test("staging answers a plain 404 with no header or cookie", async () => {
  for (const path of ["/", "/leaderboard", "/api/x", "/robots.txt"]) await assertPlain404(await stagingGate(req(path), STAGING));
});

test("the manifest and its icons pass without a cookie (browsers fetch them without one); nothing else does", async () => {
  for (const path of ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-maskable-512.png"]) assert.equal(await stagingGate(req(path), STAGING), null, path);
  assert.equal(await stagingGate(req("/manifest.webmanifest", {}, "HEAD"), STAGING), null);
  await assertPlain404(await stagingGate(req("/manifest.webmanifest", {}, "POST"), STAGING));
  for (const path of ["/manifest.webmanifest/x", "/icons/../api/x", "/icons/a/b.png", "/icons/x.svg", "/manifest.json"]) await assertPlain404(await stagingGate(req(path), STAGING));
});

test("the right x-staging-gate header lets a request through; a wrong one does not", async () => {
  assert.equal(await stagingGate(req("/", { "x-staging-gate": KEY }), STAGING), null);
  await assertPlain404(await stagingGate(req("/", { "x-staging-gate": KEY + "x" }), STAGING));
  await assertPlain404(await stagingGate(req("/", { "x-staging-gate": "" }), STAGING));
});

test("staging without a configured key stays locked", async () => {
  await assertPlain404(await stagingGate(req("/", { "x-staging-gate": "" }), { SITE_ENV: "staging" }));
  await assertPlain404(await stagingGate(req("/"), { SITE_ENV: "staging", STAGING_GATE_KEY: "" }));
});

test("a valid gate cookie lets a request through; forged, expired and other-secret ones do not", async () => {
  const good = await gateCookieValue(KEY, NOW);
  const withCookie = (v) => req("/", { cookie: `a=b; ${GATE_COOKIE}=${v}` });
  assert.equal(await stagingGate(withCookie(good), STAGING, { now: NOW + 1000 }), null);
  const [expires, sig] = good.split(".");
  await assertPlain404(await stagingGate(withCookie(`${Number(expires) + 1}.${sig}`), STAGING, { now: NOW }));
  await assertPlain404(await stagingGate(withCookie(`${expires}.${sig.slice(1)}x`), STAGING, { now: NOW }));
  await assertPlain404(await stagingGate(withCookie("garbage"), STAGING, { now: NOW }));
  await assertPlain404(await stagingGate(withCookie(good), STAGING, { now: Number(expires) + 1 }));
  assert.equal(Number(expires) - NOW, 30 * 86_400_000);
  const other = await gateCookieValue("another-secret", NOW);
  await assertPlain404(await stagingGate(withCookie(other), STAGING, { now: NOW }));
  await assertPlain404(await stagingGate(req("/", { cookie: `x-${GATE_COOKIE}=${good}` }), STAGING, { now: NOW }));
});

test("/__gate with the right key sets a Host-prefixed, HttpOnly, Secure, Lax cookie and redirects to /", async () => {
  const { options } = freshDb();
  const res = await stagingGate(req(`/__gate?key=${encodeURIComponent(KEY)}`), STAGING, options);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^${GATE_COOKIE}=\\d+\\.[\\w-]+; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax$`));
  assert.ok(!/Domain=/i.test(cookie), "__Host- cookies carry no Domain");
  // The cookie it sets opens the gate.
  const value = cookie.split(";")[0].split("=").slice(1).join("=");
  assert.equal(await stagingGate(req("/", { cookie: `${GATE_COOKIE}=${value}` }), STAGING, options), null);
});

test("/__gate with a bad, missing or POSTed key is a plain 404 and sets no cookie", async () => {
  const { options } = freshDb();
  await assertPlain404(await stagingGate(req("/__gate?key=nope"), STAGING, options));
  await assertPlain404(await stagingGate(req("/__gate"), STAGING, options));
  await assertPlain404(await stagingGate(req(`/__gate?key=${KEY}`, {}, "POST"), STAGING, options));
});

test("failed /__gate attempts are limited per address: after 10, even the right key gets a 404", async () => {
  const { options } = freshDb();
  for (let i = 0; i < FAILED_PER_DAY; i++) await assertPlain404(await stagingGate(req(`/__gate?key=wrong${i}`), STAGING, options));
  await assertPlain404(await stagingGate(req(`/__gate?key=${KEY}`), STAGING, options));
  // Another address is not affected.
  const other = req(`/__gate?key=${KEY}`, { "cf-connecting-ip": "198.51.100.9" });
  assert.equal((await stagingGate(other, STAGING, options)).status, 302);
  // The window is a day.
  const later = { ...options, now: NOW + 86_400_000 + 1 };
  assert.equal((await stagingGate(req(`/__gate?key=${KEY}`), STAGING, later)).status, 302);
});

test("a few failures do not stop the owner's right key", async () => {
  const { options } = freshDb();
  for (let i = 0; i < FAILED_PER_DAY - 1; i++) await stagingGate(req("/__gate?key=wrong"), STAGING, options);
  assert.equal((await stagingGate(req(`/__gate?key=${KEY}`), STAGING, options)).status, 302);
});

test("a database failure fails closed", async () => {
  const broken = { db: () => ({ execute: async () => { throw new Error("down"); } }), now: NOW };
  await assertPlain404(await stagingGate(req(`/__gate?key=${KEY}`), STAGING, broken));
  await assertPlain404(await stagingGate(req("/__gate?key=wrong"), STAGING, broken));
});
