// The uptime check (worker/health.ts), offline: answered before Next, with no
// cookie and no cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthCheck } from "../worker/health.ts";

const BASE = "https://portfoliorank.dev";

test("GET /healthz answers an uncached plain-text ok", async () => {
  const response = healthCheck(new Request(`${BASE}/healthz`));
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "ok");
  assert.equal(response?.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
  assert.equal(response?.headers.get("Set-Cookie"), null);
});

test("HEAD /healthz has no body", async () => {
  const response = healthCheck(new Request(`${BASE}/healthz`, { method: "HEAD" }));
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "");
});

test("every other path and method is left to the app", () => {
  assert.equal(healthCheck(new Request(`${BASE}/`)), null);
  assert.equal(healthCheck(new Request(`${BASE}/healthz/x`)), null);
  assert.equal(healthCheck(new Request(`${BASE}/healthz`, { method: "POST" })), null);
});
