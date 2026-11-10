// The prewarm loop, separate from scripts/prewarm-metrics.mjs so tests can
// drive it with a stand-in fetch. It calls the site's own /api/inspect and
// /api/psi for each URL (which fill the Turso cache), counts what worked per
// kind, and decides the exit code: a run where most lookups fail is a failed
// run, so a dead key or quota shows up as a red job instead of a green one.

export const KINDS = ["inspect", "psi"];

/** Group an error into something a person can act on. */
export function classify(error) {
  const e = String(error ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("quota") || e === "http_429" || e.includes("rate limit")) return "quota";
  if (e.includes("timeout") || e.includes("timed out") || e.includes("aborted")) return "timeout";
  // /api/psi and /api/inspect answer unknown_url for a URL the deployed
  // roster (data/feed.json at build time) doesn't have.
  if (e.includes("unknown_url")) return "not_on_roster";
  if (e.includes("api key") || e.includes("api_key")) return "api_key";
  const http = e.match(/^(?:http|psi)_(\d{3})$/);
  if (http) return `http_${http[1]}`;
  if (e === "unreachable" || e.includes("fetch failed") || e.includes("network")) return "unreachable";
  return e.length > 40 ? `${e.slice(0, 40)}…` : e;
}

/** One lookup: a success only if the endpoint answered 200 with `ok: true`. */
async function lookup(fetchFn, base, kind, url, timeoutMs) {
  try {
    const res = await fetchFn(`${base}/api/${kind}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok === true) return { ok: true };
    return { ok: false, error: classify(body?.error ?? `http_${res.status}`) };
  } catch (e) {
    return { ok: false, error: classify(e?.name === "TimeoutError" ? "timeout" : e?.message) };
  }
}

/**
 * @returns {{ exitCode: number, stats: Record<string, {attempted:number, ok:number, failed:number, errors:Record<string,number>}>, summary: string }}
 */
export async function runPrewarm({
  urls,
  base,
  fetchFn = fetch,
  pauseMs = 1200,
  timeoutMs = 60_000,
  log = console.log,
}) {
  const stats = Object.fromEntries(
    KINDS.map((k) => [k, { attempted: 0, ok: 0, failed: 0, errors: {} }])
  );
  for (const [i, url] of urls.entries()) {
    for (const kind of KINDS) {
      const r = await lookup(fetchFn, base, kind, url, timeoutMs);
      const s = stats[kind];
      s.attempted++;
      if (r.ok) s.ok++;
      else {
        s.failed++;
        s.errors[r.error] = (s.errors[r.error] ?? 0) + 1;
      }
      log(`[${i + 1}/${urls.length}] ${kind} ${url} -> ${r.ok ? "ok" : r.error}`);
      if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
    }
  }

  const attempted = KINDS.reduce((n, k) => n + stats[k].attempted, 0);
  const ok = KINDS.reduce((n, k) => n + stats[k].ok, 0);
  const failed = attempted - ok;
  const allErrors = {};
  for (const k of KINDS)
    for (const [e, n] of Object.entries(stats[k].errors)) allErrors[e] = (allErrors[e] ?? 0) + n;
  const top = Object.entries(allErrors).sort((a, b) => b[1] - a[1])[0];

  const tooMany = attempted > 0 && (failed > attempted / 2 || ok === 0);
  const verdict = attempted === 0
    ? "Nothing to prewarm."
    : tooMany
      ? `FAILED: ${failed} of ${attempted} lookups failed; most common error: ${top[0]} (${top[1]}).`
      : `OK: ${ok} of ${attempted} lookups succeeded.`;

  const fmtErrors = (errors) =>
    Object.entries(errors)
      .sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${e} ${n}`)
      .join(", ") || "-";
  const summary = [
    "## Prewarm metrics",
    "",
    verdict,
    "",
    "| Kind | Attempted | OK | Failed | Errors |",
    "| --- | ---: | ---: | ---: | --- |",
    ...KINDS.map((k) => {
      const s = stats[k];
      return `| ${k} | ${s.attempted} | ${s.ok} | ${s.failed} | ${fmtErrors(s.errors)} |`;
    }),
    "",
  ].join("\n");

  return { exitCode: tooMany ? 1 : 0, stats, summary, verdict };
}
