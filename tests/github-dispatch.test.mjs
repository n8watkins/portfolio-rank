// Starting the nightly checks on GitHub Actions from the Worker
// (pipeline/github-dispatch.mjs), offline with a stand-in for GitHub's API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MISSING_TOKEN, dispatchWorkflow, workflowRun } from "../pipeline/github-dispatch.mjs";

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
  assert.deepEqual(r, { runId: 42, url: "https://github.com/n8watkins/portfolio-rank/actions/runs/42" });
  assert.equal(seen[0].url, "https://api.github.com/repos/n8watkins/portfolio-rank/actions/workflows/sync-upstream.yml/dispatches");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.ok(seen[0].init.headers["user-agent"], "GitHub's API needs a User-Agent");
  assert.deepEqual(JSON.parse(seen[0].init.body), { ref: "main", inputs: { refresh: "150" }, return_run_details: true });
  assert.ok(!lines.join("").includes(SECRET), "the token is never logged");
  // Older behaviour: 204 without run details.
  assert.deepEqual(await dispatchWorkflow({ token: SECRET, workflow: "health.yml", fetchImpl: async () => new Response(null, { status: 204 }) }), { runId: null, url: null });
});

test("a refused dispatch throws without the token in the message; a run's status is read back", async () => {
  await assert.rejects(
    dispatchWorkflow({ token: SECRET, workflow: "sync-upstream.yml", fetchImpl: async () => new Response("Resource not accessible by personal access token", { status: 403 }) }),
    (e) => /HTTP 403/.test(e.message) && !e.message.includes(SECRET)
  );
  const run = await workflowRun({ token: SECRET, runId: 42, fetchImpl: async () => new Response(JSON.stringify({ status: "completed", conclusion: "success", html_url: "u" }), { status: 200 }) });
  assert.deepEqual(run, { status: "completed", conclusion: "success", url: "u" });
});
