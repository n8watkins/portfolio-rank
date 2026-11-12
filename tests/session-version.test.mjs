// End to end (`npm run test:e2e`): a session from before the current session
// version (lib/session-version.mjs) is treated as signed out, and its cookie
// is cleared; a current one is read as before. Only sessions are affected:
// the same AUTH_SECRET still opens everything else it signs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionCookie } from "./helpers/session.mjs";
import { SESSION_VERSION, isCurrentSession } from "../lib/session-version.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";

const sessionOf = (cookie) => fetch(`${BASE}/api/auth/session`, { headers: { cookie } });

test("the version check accepts only the current version", () => {
  assert.equal(isCurrentSession({ sv: SESSION_VERSION }), true);
  assert.equal(isCurrentSession({ sv: SESSION_VERSION - 1 }), false);
  assert.equal(isCurrentSession({}), false);
  assert.equal(isCurrentSession(null), false);
});

test("a session with the current version is signed in", async () => {
  const res = await sessionOf(await sessionCookie({ id: 710000001, login: "current-session" }));
  const body = await res.json();
  assert.equal(body?.raterId, "gh:710000001");
  assert.equal(body?.login, "current-session");
});

test("an old-style session (no version claim, or an older one) is signed out and its cookie cleared", async () => {
  for (const version of [null, SESSION_VERSION - 1]) {
    const res = await sessionOf(await sessionCookie({ id: 710000002, version }));
    assert.equal(res.status, 200);
    assert.equal(await res.json(), null, `version ${version} is signed out`);
    const cleared = (res.headers.getSetCookie?.() ?? []).some((sc) => sc.startsWith("authjs.session-token=;") || /authjs\.session-token=;?/.test(sc) || /max-age=0/i.test(sc));
    assert.ok(cleared, "the session cookie is cleared");
  }
});
