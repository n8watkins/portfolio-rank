// Starting GitHub Actions work from Cloudflare (worker/night.ts): the work
// that needs a real browser (capture, the health check) stays on Actions,
// but GitHub's own schedule starts hours late, so the Worker's Cron Trigger
// starts it with a workflow_dispatch at a known time and waits for it.
//
// The token is the Worker secret GITHUB_DISPATCH_TOKEN: a fine-grained token
// for n8watkins/portfolio-rank only, with "Actions: read and write" and
// nothing else. Without it every dispatch is skipped with one clear log line
// and the run goes on with what is already captured.

export const REPO = "n8watkins/portfolio-rank";
const API = "https://api.github.com";

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "portfolio-rank-worker",
  "content-type": "application/json",
});

export const MISSING_TOKEN = "GITHUB_DISPATCH_TOKEN is not set";

/**
 * Starts `workflow` (a file name in .github/workflows) on `ref`. Returns
 * { runId, url } (runId null when GitHub doesn't say), or { skipped } when
 * there is no token. Throws on any other failure. `apiBase` is GitHub's API
 * (a local stand-in in the tests).
 */
export async function dispatchWorkflow({ token, workflow, inputs = {}, ref = "main", repo = REPO, fetchImpl = fetch, log = console.log, apiBase = API }) {
  if (!token) {
    const skipped = `${MISSING_TOKEN}: skipped starting ${workflow} on GitHub Actions (add the Worker secret to start it from Cloudflare; its GitHub schedule stays as the fallback)`;
    log(skipped);
    return { skipped };
  }
  const res = await fetchImpl(`${apiBase}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ ref, inputs, return_run_details: true }),
  });
  if (res.status === 204) return { runId: null, url: null };
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { runId: body.workflow_run_id ?? null, url: body.html_url ?? null };
  }
  const text = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`starting ${workflow} on GitHub failed: HTTP ${res.status} ${text}`);
}

/** A workflow run's { status, conclusion, url } ("queued", "in_progress", "completed"). */
export async function workflowRun({ token, runId, repo = REPO, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API}/repos/${repo}/actions/runs/${runId}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`reading GitHub run ${runId} failed: HTTP ${res.status}`);
  const body = await res.json();
  return { status: String(body.status ?? "unknown"), conclusion: body.conclusion == null ? null : String(body.conclusion), url: body.html_url ?? null };
}
