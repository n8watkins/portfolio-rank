// Edges of the site, over HTTP against the running production build (see
// scripts/test-e2e.sh): unknown paths and the headers that let analytics and
// error reports through.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";

test("an unknown path answers 404 with PortfolioRank's not-found page", async () => {
  const res = await fetch(`${BASE}/zz-no-such-page`, { redirect: "manual" });
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /<h1[^>]*>That page isn(?:'|&#x27;|&#39;)t here\.<\/h1>/);
  assert.match(html, /href="\/rank"/);
});

test("the CSP lets Cloudflare Web Analytics and Sentry through", async () => {
  const res = await fetch(`${BASE}/zz-no-such-page`, { redirect: "manual" });
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
  assert.match(csp, /connect-src [^;]*\.ingest\.us\.sentry\.io/);
});
