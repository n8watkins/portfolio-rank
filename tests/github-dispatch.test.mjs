// Starting the nightly checks on GitHub Actions from the Worker
// (pipeline/github-dispatch.mjs), offline with a stand-in for GitHub's API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MISSING_TOKEN, dispatchWorkflow, tokenExpiry, workflowRun } from "../pipeline/github-dispatch.mjs";
import { DISPATCH_TOKEN_WARN_DAYS, dispatchTokenConditions } from "../pipeline/alerts.mjs";

const SECRET = "github_pat_test_not_real";

test("without GITHUB_DISPATCH_TOKEN the dispatch is skipped with one clear log line and no request", async () => {
  const lines = [];
  let called = false;
  const r = await dispatchWorkflow({ token: undefined, workflow: "sync-upstream.yml", fetchImpl: async () => (called = true), log: (l) => lines.push(l) });
  assert.equal(called, false);
  assert.match(r.skipped, new RegExp(`^${MISSING_TOKEN}: skipped starting sync-upstream.yml`));
  assert.deepEqual(lines, [r.skipped]);
});

test("a dispatch posts to the workflow on main with the inputs and returns the run", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ workflow_run_id: 42, html_url: "https://github.com/n8watkins/portfolio-rank/actions/runs/42" }), { status: 200 });
  };
  const lines = [];
  const r = await dispatchWorkflow({ token: SECRET, workflow: "sync-upstream.yml", inputs: { refresh: "150" }, fetchImpl, log: (l) => lines.push(l) });
  assert.deepEqual(r, { runId: 42, url: "https://github.com/n8watkins/portfolio-rank/actions/runs/42", tokenExpires: null });
  assert.equal(seen[0].url, "https://api.github.com/repos/n8watkins/portfolio-rank/actions/workflows/sync-upstream.yml/dispatches");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.ok(seen[0].init.headers["user-agent"], "GitHub's API needs a User-Agent");
  assert.deepEqual(JSON.parse(seen[0].init.body), { ref: "main", inputs: { refresh: "150" }, return_run_details: true });
  assert.ok(!lines.join("").includes(SECRET), "the token is never logged");
  // Older behaviour: 204 without run details.
  assert.deepEqual(await dispatchWorkflow({ token: SECRET, workflow: "health.yml", fetchImpl: async () => new Response(null, { status: 204 }) }), { runId: null, url: null, tokenExpires: null });
});

test("a refused dispatch throws without the token in the message; a run's status is read back", async () => {
  await assert.rejects(
    dispatchWorkflow({ token: SECRET, workflow: "sync-upstream.yml", fetchImpl: async () => new Response("Resource not accessible by personal access token", { status: 403 }) }),
    (e) => /HTTP 403/.test(e.message) && !e.message.includes(SECRET)
  );
  const run = await workflowRun({ token: SECRET, runId: 42, fetchImpl: async () => new Response(JSON.stringify({ status: "completed", conclusion: "success", html_url: "u" }), { status: 200 }) });
  assert.deepEqual(run, { status: "completed", conclusion: "success", url: "u" });
});

test("GitHub's token expiry header is read in UTC or with an offset; anything else is no expiry", () => {
  const h = (v) => new Headers(v == null ? {} : { "GitHub-Authentication-Token-Expiration": v });
  assert.equal(tokenExpiry(h("2026-12-01 00:00:00 UTC")), "2026-12-01T00:00:00.000Z");
  assert.equal(tokenExpiry(h("2026-12-01 00:00:00 -0800")), "2026-12-01T08:00:00.000Z");
  assert.equal(tokenExpiry(h("2026-12-01 00:00:00 +05:30")), "2026-11-30T18:30:00.000Z");
  for (const v of [null, "", "never", "2026-13-45 99:00:00 UTC"]) assert.equal(tokenExpiry(h(v)), null, String(v));
});

test("a dispatch returns when its token expires", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ workflow_run_id: 7, html_url: "u" }), { status: 200, headers: { "github-authentication-token-expiration": "2026-11-20 12:00:00 UTC" } });
  const r = await dispatchWorkflow({ token: SECRET, workflow: "sync-upstream.yml", fetchImpl });
  assert.equal(r.tokenExpires, "2026-11-20T12:00:00.000Z");
});

test("owner alerts: a missing token, and one that expires within the warning days or has expired", () => {
  const now = new Date("2026-11-13T04:30:00Z");
  const inDays = (d) => new Date(now.getTime() + d * 86400000).toISOString();
  assert.deepEqual(dispatchTokenConditions(null, { now }), []);
  assert.deepEqual(dispatchTokenConditions({ runId: 1, url: null, tokenExpires: null }, { now }), [], "a token without an expiry");
  assert.deepEqual(dispatchTokenConditions({ runId: 1, url: null, tokenExpires: inDays(DISPATCH_TOKEN_WARN_DAYS + 1) }, { now }), []);
  const missing = dispatchTokenConditions({ skipped: `${MISSING_TOKEN}: skipped starting sync-upstream.yml` }, { now });
  assert.deepEqual(missing.map((c) => [c.key, c.kind]), [["dispatch-token:missing", "problem"]]);
  const soon = dispatchTokenConditions({ runId: 1, url: null, tokenExpires: inDays(5.5) }, { now });
  assert.deepEqual(soon.map((c) => c.key), ["dispatch-token:expiring"]);
  assert.match(soon[0].title, /expires on 2026-11-18 \(5 day\(s\) left\)/);
  const gone = dispatchTokenConditions({ runId: 1, url: null, tokenExpires: inDays(-2) }, { now });
  assert.match(gone[0].title, /expired on 2026-11-10/, "the Pacific day");
  for (const c of [...missing, ...soon, ...gone]) assert.ok(!JSON.stringify(c).includes(SECRET));
});
