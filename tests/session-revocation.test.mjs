// Ending sessions early (lib/session-revocation.mjs, auth.ts): "Sign out
// everywhere" and account deletion sign out every session of the account;
// the admin's session ends 12 hours after sign-in. The rules offline, then
// end to end against the running build (scripts/test-e2e.sh).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "@auth/core/jwt";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ADMIN_SESSION_MS, REVOCATION_TTL_MS, adminRaterId, revokeSessions, revokedAt, sessionValid, signedInAt } from "../lib/session-revocation.mjs";
import { SESSION_VERSION } from "../lib/session-version.mjs";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const HOUR = 3600_000;
const NOW = Date.parse("2026-11-13T12:00:00Z");

test("the sign-in time is the at claim, else the issue time", () => {
  assert.equal(signedInAt({ at: 1000, iat: 5 }), 1000);
  assert.equal(signedInAt({ iat: 5 }), 5000);
  assert.equal(signedInAt({}), null);
  assert.equal(signedInAt(null), null);
});

test("a session signed in at or before the revoked time ends; one after goes on", () => {
  const at = NOW - HOUR;
  assert.equal(sessionValid({ at }, { revokedAt: null, isAdmin: false, now: NOW }), true);
  assert.equal(sessionValid({ at }, { revokedAt: at, isAdmin: false, now: NOW }), false);
  assert.equal(sessionValid({ at }, { revokedAt: at + 1, isAdmin: false, now: NOW }), false);
  assert.equal(sessionValid({ at }, { revokedAt: at - 1, isAdmin: false, now: NOW }), true, "signed in again after the revocation");
  assert.equal(sessionValid({}, { revokedAt: null, isAdmin: false, now: NOW }), true, "no time at all and nothing revoked");
  assert.equal(sessionValid({}, { revokedAt: 1, isAdmin: false, now: NOW }), false);
});

test("the admin's session ends 12 hours after sign-in, however recently it was used", () => {
  assert.equal(ADMIN_SESSION_MS, 12 * HOUR);
  assert.equal(sessionValid({ at: NOW - 11 * HOUR }, { revokedAt: null, isAdmin: true, now: NOW }), true);
  assert.equal(sessionValid({ at: NOW - 13 * HOUR }, { revokedAt: null, isAdmin: true, now: NOW }), false);
  assert.equal(sessionValid({ at: NOW - 13 * HOUR }, { revokedAt: null, isAdmin: false, now: NOW }), true, "everyone else keeps 30 days");
  assert.equal(sessionValid({}, { revokedAt: null, isAdmin: true, now: NOW }), false);
  assert.equal(adminRaterId({ ADMIN_GITHUB_ID: " 8055935 " }), "gh:8055935");
  for (const id of [undefined, "", "abc", "gh:1"]) assert.equal(adminRaterId({ ADMIN_GITHUB_ID: id }), null, String(id));
});

test("revoking stores the latest time, never an earlier one, and the isolate sees it at once", async () => {
  const db = createClient({ url: `file:${path.join(mkdtempSync(path.join(tmpdir(), "pr-revoke-")), "db.sqlite")}` });
  await migrate(db);
  assert.equal(await revokedAt(db, "gh:1", { now: NOW }), null);
  await revokeSessions(db, "gh:1", { now: NOW });
  assert.equal(await revokedAt(db, "gh:1", { now: NOW }), NOW);
  await revokeSessions(db, "gh:1", { now: NOW - HOUR });
  assert.equal(await revokedAt(db, "gh:1", { now: NOW + REVOCATION_TTL_MS + 1 }), NOW, "a later read from the database keeps the latest");
  assert.equal(await revokedAt(db, "gh:2", { now: NOW }), null, "per account");
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------
const sessionOf = async (cookie) => (await fetch(`${BASE}/api/auth/session`, { headers: { cookie } })).json();

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/rank")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

test("sign out everywhere: this session and every other one of the account end; other accounts don't", async () => {
  const id = 720000001;
  const phone = await sessionCookie({ id, login: "everywhere" });
  const laptop = await sessionCookie({ id, login: "everywhere" });
  const someoneElse = await sessionCookie({ id: 720000002 });
  assert.equal((await sessionOf(phone))?.raterId, `gh:${id}`);
  // A cross-site request can't do it.
  assert.equal((await fetch(`${BASE}/api/account/sessions`, { method: "POST", headers: { cookie: phone, origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${BASE}/api/account/sessions`, { method: "POST", headers: { origin: BASE } })).status, 401);
  // Sessions issued in the same second as the revocation count as before it.
  await new Promise((r) => setTimeout(r, 1100));
  const res = await fetch(`${BASE}/api/account/sessions`, { method: "POST", headers: { cookie: phone, origin: BASE } });
  assert.equal(res.status, 200);
  assert.equal(await sessionOf(phone), null);
  assert.equal(await sessionOf(laptop), null);
  assert.equal((await sessionOf(someoneElse))?.raterId, "gh:720000002");
  // Signing in again afterwards works.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await sessionOf(await sessionCookie({ id, login: "everywhere" })))?.raterId, `gh:${id}`);
});

test("an admin session signed in 13 hours ago is signed out; a fresh one is not", async () => {
  const token = (at) =>
    encode({
      token: { raterId: `gh:${ADMIN_ID}`, login: "admin", sub: String(ADMIN_ID), sv: SESSION_VERSION, at, accountCreatedAt: "2020-01-01T00:00:00Z" },
      secret: process.env.AUTH_SECRET,
      salt: "authjs.session-token",
      maxAge: 3600,
    });
  assert.equal(await sessionOf(`authjs.session-token=${await token(Date.now() - 13 * HOUR)}`), null);
  assert.equal((await sessionOf(`authjs.session-token=${await token(Date.now() - HOUR)}`))?.raterId, `gh:${ADMIN_ID}`);
});
