// A signed-out visitor's session read (worker/anonymous-session.ts), offline:
// answered before Next with what Auth.js would send, and only when there is no
// session cookie at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anonymousSession } from "../worker/anonymous-session.ts";

const BASE = "https://portfoliorank.n8builds.dev";
const session = (headers = {}, method = "GET", path = "/api/auth/session") =>
  new Request(`${BASE}${path}`, { method, headers });

test("without a session cookie the answer is Auth.js's uncached null", async () => {
  const response = anonymousSession(session({ Cookie: "theme=dark; __Host-authjs.csrf-token=abc" }));
  assert.equal(response?.status, 200);
  assert.equal(await response?.json(), null);
  assert.equal(response?.headers.get("Content-Type"), "application/json");
  assert.equal(response?.headers.get("Cache-Control"), "private, no-cache, no-store");
  assert.equal(response?.headers.get("Set-Cookie"), null);
  assert.ok(anonymousSession(session()));
});

test("any session cookie, plain, secure or chunked, goes to Auth.js", () => {
  for (const cookie of [
    "authjs.session-token=x",
    "__Secure-authjs.session-token=x",
    "a=1; __Secure-authjs.session-token.0=x; __Secure-authjs.session-token.1=y",
    "theme=dark;authjs.session-token.0=x",
  ]) {
    assert.equal(anonymousSession(session({ Cookie: cookie })), null, cookie);
  }
});

test("other methods and other auth paths are left to the app", () => {
  assert.equal(anonymousSession(session({}, "POST")), null);
  assert.equal(anonymousSession(session({}, "HEAD")), null);
  assert.equal(anonymousSession(session({}, "GET", "/api/auth/csrf")), null);
  assert.equal(anonymousSession(session({}, "GET", "/api/auth/session/x")), null);
});
