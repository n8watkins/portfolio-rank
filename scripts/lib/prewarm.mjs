// The prewarm loop, separate from scripts/prewarm-metrics.mjs so tests can
// drive it with a stand-in fetch. It calls the site's own /api/inspect and
// /api/psi for each URL (which fill the Turso cache), counts what worked per
// kind, and decides the exit code: a run where most lookups fail is a failed
// run, so a dead key or quota shows up as a red job instead of a green one.

import { GEMINI_YES_SQL, SIGNALS_SQL } from "../../lib/tiers-store.mjs";
import { STRONG_SIGNALS } from "../../pipeline/portfolio-guard.mjs";
import { FRESHNESS_TABLES, dueSql } from "../../lib/freshness.mjs";
import { PREWARM_CONCURRENCY, pacing } from "../../lib/psi-pacing.mjs";
import { INTERNAL_TOKEN_HEADER } from "../../lib/internal-token.mjs";

export const KINDS = ["inspect", "psi"];

// Sites a daily run measures at most. A site's PageSpeed measure is four
// runs (two phone, two desktop, lib/psi-runs.mjs), so 400 sites are 1,600
// runs, 6.4% of PageSpeed's 25,000 a day (lib/psi-pacing.mjs pacing()). A
// measure takes about 80 s if a run takes ~25 s (a guess, not measured) with a
// 30 s gap between a device's runs, the two devices side by side, so the sites
// go PREWARM_CONCURRENCY at a time: 400 sites take about 3 hours, inside the
// job's 330 minutes (one at a time they would take 8.9 hours and the job
// would be cut off).
export const PREWARM_LIMIT = 400;
/** What the schedule above costs, for the job summary and the tests. */
export const PREWARM_PLAN = pacing({ sites: PREWARM_LIMIT, concurrency: PREWARM_CONCURRENCY });
/** The wait for one /api/psi answer (ms): it measures four runs before it answers. */
export const PSI_TIMEOUT_MS = 300_000;

// A stored Lighthouse result is a good one (ok) of fewer than two runs attempted: stored before two runs a
// device, or by a visitor's speed check. Written for a cache row aliased `x`.
const SINGLE_RUN = (x) => `(json_valid(${x}.v) AND json_extract(${x}.v, '$.ok') = 1 AND COALESCE(json_extract(${x}.v, '$.runsAttempted'), 1) < 2)`;
const GOOD = (x) => `COALESCE(json_valid(${x}.v) AND json_extract(${x}.v, '$.ok') = 1, 0)`;

/**
 * The sites to prewarm: listed (active(p)), live, not graded "not a
 * portfolio", and a library member or one by the membership rule
 * (lib/tiers-store.mjs libraryMember): Gemini said "a portfolio", or a
 * captured site with measured facts and at least STRONG_SIGNALS of the six
 * portfolio signals, or a member already (the owner kept it), so every
 * member gets its own Lighthouse whether Gemini graded it or not (owner,
 * 2026-11-22: the Starting rank comes from code).
 * A site is due by the check rule of lib/freshness.mjs (dueSql "lighthouse"):
 * never measured, asked for again by the admin's Re-measure, a failure older
 * than its hour, or a good result older than 90 days. Also due: a good phone
 * result of one run, or a good phone result with no good desktop result or
 * one of a single run (stored before two runs a device, or by a visitor's
 * speed check). Order: asked for first, then never measured, then the oldest.
 * @param {{ execute: Function }} db
 * @param {{ active: (p: string) => string, limit?: number, now?: number }} options
 */
export async function prewarmQueue(db, { active, limit = PREWARM_LIMIT, now = Date.now() }) {
  // The admin's "Re-measure" requests (site_freshness) are read below; a database that never had them has none.
  for (const sql of FRESHNESS_TABLES) await db.execute(sql);
  const tiers = (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_ratings'")).rows.length > 0;
  const member = tiers ? "OR EXISTS (SELECT 1 FROM tier_ratings t WHERE t.url = p.url AND t.member = 1)" : "";
  const due = dueSql("lighthouse", { at: "c.at", failed: `${GOOD("c")} = 0`, now });
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p
          LEFT JOIN cache c ON c.k = 'psi:' || p.url
          LEFT JOIN cache d ON d.k = 'psi-desktop:' || p.url
          LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")}
            AND NOT (CASE WHEN json_valid(p.ai_rubric) THEN COALESCE(json_extract(p.ai_rubric, '$.is_portfolio') = 0, 0) ELSE 0 END)
            AND (${GEMINI_YES_SQL("p")}
              OR (p.shot_key IS NOT NULL AND COALESCE(json_valid(p.facts), 0) AND ${SIGNALS_SQL("p")} >= ${STRONG_SIGNALS})
              ${member})
            AND (${due}
              OR ${SINGLE_RUN("c")}
              OR (${GOOD("c")} = 1 AND (d.v IS NULL OR ${SINGLE_RUN("d")})))
          ORDER BY CASE WHEN c.at IS NOT NULL AND COALESCE(f.forced_at, 0) > c.at THEN 0 ELSE 1 END, c.at IS NOT NULL, COALESCE(c.at, 0), p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => String(r.url));
}

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

/**
 * One lookup. /api/inspect: a success when it answered 200 with `ok: true`.
 * /api/psi with the internal token: a success only when a new result was
 * stored ({ ok: true, measured: true }); a busy site, a failed measure and an
 * answer that stored nothing are failures with their reason.
 */
async function lookup(fetchFn, base, kind, url, timeoutMs, psiToken) {
  try {
    const headers = kind === "psi" && psiToken ? { [INTERNAL_TOKEN_HEADER]: psiToken } : undefined;
    const res = await fetchFn(`${base}/api/${kind}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(headers ? { headers } : {}),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok === true) {
      if (kind !== "psi" || body.measured === true) return { ok: true };
      return { ok: false, error: "not_stored" };
    }
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
  psiTimeoutMs = PSI_TIMEOUT_MS,
  concurrency = 1,
  psiToken = "",
  log = console.log,
}) {
  const stats = Object.fromEntries(
    KINDS.map((k) => [k, { attempted: 0, ok: 0, failed: 0, errors: {} }])
  );
  // `concurrency` sites at a time; one site's lookups stay in order.
  let next = 0;
  // Set when PageSpeed refuses (quota): no site is started after that, since every measure would be refused too.
  let stopped = null;
  const worker = async () => {
    while (!stopped && next < urls.length) {
      const i = next++;
      const url = urls[i];
      for (const kind of KINDS) {
        const r = await lookup(fetchFn, base, kind, url, kind === "psi" ? psiTimeoutMs : timeoutMs, psiToken);
        const s = stats[kind];
        s.attempted++;
        if (r.ok) s.ok++;
        else {
          s.failed++;
          s.errors[r.error] = (s.errors[r.error] ?? 0) + 1;
        }
        log(`[${i + 1}/${urls.length}] ${kind} ${url} -> ${r.ok ? (kind === "psi" ? "measured" : "ok") : r.error}`);
        if (kind === "psi" && r.error === "quota") stopped = `PageSpeed refused (quota) at site ${i + 1} of ${urls.length}`;
        if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length || 1)) }, worker));

  const attempted = KINDS.reduce((n, k) => n + stats[k].attempted, 0);
  const ok = KINDS.reduce((n, k) => n + stats[k].ok, 0);
  const failed = attempted - ok;
  const allErrors = {};
  for (const k of KINDS)
    for (const [e, n] of Object.entries(stats[k].errors)) allErrors[e] = (allErrors[e] ?? 0) + n;
  const top = Object.entries(allErrors).sort((a, b) => b[1] - a[1])[0];

  const notStarted = Math.max(0, urls.length - next);
  const tooMany = attempted > 0 && (failed > attempted / 2 || ok === 0);
  const verdict = attempted === 0
    ? "Nothing to prewarm."
    : stopped
      ? `STOPPED: ${stopped}; ${notStarted} site(s) not tried; ${stats.psi.ok} measured.`
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
    // A site counts as measured only when a new result was stored.
    `PageSpeed: ${stats.psi.ok} site(s) measured (a new result stored), ${stats.psi.failed} not measured (${fmtErrors(stats.psi.errors)})${notStarted ? `, ${notStarted} not tried` : ""}.`,
    "",
  ].join("\n");

  return { exitCode: tooMany || stopped ? 1 : 0, stats, summary, verdict };
}
