// The prewarm loop, separate from scripts/prewarm-metrics.mjs so tests can
// drive it with stand-ins. For each site it calls the site's own /api/inspect
// (which fills the polish cache) and measures Lighthouse itself: `measure`
// (lib/psi-job.mjs measureAndStore) calls PageSpeed from the job's runner and
// writes the results to the database. It counts what worked per kind, and
// decides the exit code: a run where most lookups fail is a failed run, so a
// dead key or quota shows up as a red job instead of a green one.

import { GEMINI_YES_SQL, SIGNALS_SQL } from "../../lib/tiers-store.mjs";
import { STRONG_SIGNALS } from "../../pipeline/portfolio-guard.mjs";
import { FRESHNESS_TABLES, dueSql } from "../../lib/freshness.mjs";
import { FAILED_RETRY_MS, PREWARM_CONCURRENCY, pacing } from "../../lib/psi-pacing.mjs";

export const KINDS = ["inspect", "psi"];

// Sites a daily run measures at most. A full measure is four runs (two phone,
// two desktop, lib/psi-runs.mjs), so 400 sites are at most 1,600 runs, 6.4% of
// PageSpeed's 25,000 a day (lib/psi-pacing.mjs pacing()); a site with only one
// device due costs two. A full measure takes about 80 s if a run takes ~25 s (a
// guess, not measured) with a 30 s gap between a device's runs, the two devices
// side by side, so the sites go PREWARM_CONCURRENCY at a time: 400 sites take
// about 3 hours, inside the job's 330 minutes (one at a time they would take
// 8.9 hours and the job would be cut off).
//
// A device whose last result is a failure is tried again only after
// FAILED_RETRY_MS (20 hours), so a site whose device keeps failing costs at
// most two runs a device a day, however often the job runs: 100 such sites
// are at most 400 runs a day, 1.6% of the day's quota.
export const PREWARM_LIMIT = 400;
/** What the schedule above costs, for the job summary and the tests. */
export const PREWARM_PLAN = pacing({ sites: PREWARM_LIMIT, concurrency: PREWARM_CONCURRENCY });
/** After this many sites in a row refused for a per-minute limit (after their own retries) the job stops: something is wrong, and going on would only spend calls. */
export const RATE_LIMITED_STREAK_STOP = 10;

// A stored Lighthouse result is a good one (ok) of fewer than two runs attempted: stored before two runs a
// device, or by a visitor's speed check. Written for a cache row aliased `x`.
const SINGLE_RUN = (x) => `(json_valid(${x}.v) AND json_extract(${x}.v, '$.ok') = 1 AND COALESCE(json_extract(${x}.v, '$.runsAttempted'), 1) < 2)`;
const GOOD = (x) => `COALESCE(json_valid(${x}.v) AND json_extract(${x}.v, '$.ok') = 1, 0)`;

/**
 * The sites to prewarm, each with the devices to measure: listed (active(p)),
 * live, not graded "not a portfolio", and a library member or one by the
 * membership rule (lib/tiers-store.mjs libraryMember): Gemini said "a
 * portfolio", or a captured site with measured facts and at least
 * STRONG_SIGNALS of the six portfolio signals, or a member already (the owner
 * kept it), so every member gets its own Lighthouse whether Gemini graded it
 * or not (owner, 2026-11-22: the Starting rank comes from code).
 * A device (phone: "psi:<url>", desktop: "psi-desktop:<url>") is due when it
 * has no result, the admin asked for a re-measure after it (Re-measure,
 * lib/freshness.mjs dueSql "lighthouse"), its good result is older than 90
 * days or is one run (stored before two runs a device, or by a visitor's
 * speed check), or its result is a failure older than FAILED_RETRY_MS. A site
 * is returned with only the devices that are due, so a site whose phone result
 * is fresh and desktop is missing costs two runs, not four.
 * Order: asked for first, then never measured, then the oldest.
 * @param {{ execute: Function }} db
 * @param {{ active: (p: string) => string, limit?: number, now?: number }} options
 * @returns {Promise<{ url: string, devices: ("mobile" | "desktop")[] }[]>}
 */
export async function prewarmQueue(db, { active, limit = PREWARM_LIMIT, now = Date.now() }) {
  // The admin's "Re-measure" requests (site_freshness) are read below; a database that never had them has none.
  for (const sql of FRESHNESS_TABLES) await db.execute(sql);
  const tiers = (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_ratings'")).rows.length > 0;
  const member = tiers ? "OR EXISTS (SELECT 1 FROM tier_ratings t WHERE t.url = p.url AND t.member = 1)" : "";
  const t = Math.floor(Number(now));
  const dueDevice = (x) =>
    `(${dueSql("lighthouse", { at: `${x}.at`, failed: "0", now })} OR ${SINGLE_RUN(x)} OR (NOT ${GOOD(x)} AND ${x}.at <= ${t - FAILED_RETRY_MS}))`;
  const res = await db.execute({
    sql: `SELECT p.url, ${dueDevice("c")} AS m, ${dueDevice("d")} AS d FROM portfolios p
          LEFT JOIN cache c ON c.k = 'psi:' || p.url
          LEFT JOIN cache d ON d.k = 'psi-desktop:' || p.url
          LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")}
            AND NOT (CASE WHEN json_valid(p.ai_rubric) THEN COALESCE(json_extract(p.ai_rubric, '$.is_portfolio') = 0, 0) ELSE 0 END)
            AND (${GEMINI_YES_SQL("p")}
              OR (p.shot_key IS NOT NULL AND COALESCE(json_valid(p.facts), 0) AND ${SIGNALS_SQL("p")} >= ${STRONG_SIGNALS})
              ${member})
            AND (${dueDevice("c")} OR ${dueDevice("d")})
          ORDER BY CASE WHEN c.at IS NOT NULL AND COALESCE(f.forced_at, 0) > c.at THEN 0 ELSE 1 END, c.at IS NOT NULL, COALESCE(c.at, 0), p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => ({ url: String(r.url), devices: [...(Number(r.m) ? ["mobile"] : []), ...(Number(r.d) ? ["desktop"] : [])] }));
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

/** One /api/inspect lookup: a success when it answered 200 with `ok: true`. */
async function lookup(fetchFn, base, url, timeoutMs) {
  try {
    const res = await fetchFn(`${base}/api/inspect?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok === true) return { ok: true };
    return { ok: false, error: classify(body?.error ?? `http_${res.status}`) };
  } catch (e) {
    return { ok: false, error: classify(e?.name === "TimeoutError" ? "timeout" : e?.message) };
  }
}

/** One Lighthouse measure through `measure`: a success only when every device asked for stored a new result. */
async function measureSite(measure, url, devices) {
  try {
    const r = await measure({ url, devices });
    return r?.ok === true ? { ok: true } : { ok: false, error: classify(r?.error ?? "unknown") };
  } catch (e) {
    return { ok: false, error: classify(e?.message) };
  }
}

/**
 * @returns {{ exitCode: number, stats: Record<string, {attempted:number, ok:number, failed:number, errors:Record<string,number>}>, summary: string }}
 */
export async function runPrewarm({
  urls,
  base,
  fetchFn = fetch,
  measure,
  pauseMs = 1200,
  timeoutMs = 60_000,
  concurrency = 1,
  log = console.log,
}) {
  const stats = Object.fromEntries(
    KINDS.map((k) => [k, { attempted: 0, ok: 0, failed: 0, errors: {} }])
  );
  // `concurrency` sites at a time; one site's lookups stay in order.
  let next = 0;
  // Set when PageSpeed refuses (quota): no site is started after that, since every measure would be refused too.
  let stopped = null;
  // Sites in a row refused for a per-minute limit, after their own retries.
  let rateLimited = 0;
  const worker = async () => {
    while (!stopped && next < urls.length) {
      const i = next++;
      // A site is a URL (both devices) or { url, devices }.
      const { url, devices } = typeof urls[i] === "string" ? { url: urls[i], devices: ["mobile", "desktop"] } : urls[i];
      for (const kind of KINDS) {
        const r = kind === "psi" ? await measureSite(measure, url, devices) : await lookup(fetchFn, base, url, timeoutMs);
        const s = stats[kind];
        s.attempted++;
        if (r.ok) s.ok++;
        else {
          s.failed++;
          s.errors[r.error] = (s.errors[r.error] ?? 0) + 1;
        }
        log(`[${i + 1}/${urls.length}] ${kind} ${url} -> ${r.ok ? (kind === "psi" ? "measured" : "ok") : r.error}`);
        if (kind === "psi") {
          rateLimited = r.error === "rate_limited" ? rateLimited + 1 : 0;
          if (r.error === "quota") stopped = `PageSpeed refused the day's quota at site ${i + 1} of ${urls.length}`;
          else if (rateLimited >= RATE_LIMITED_STREAK_STOP) stopped = `PageSpeed kept refusing for its per-minute limit for ${rateLimited} sites in a row (at site ${i + 1} of ${urls.length})`;
        }
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
  // Lighthouse measuring nothing at all is a failure on its own, even when the polish checks work.
  const tooMany = attempted > 0 && (failed > attempted / 2 || ok === 0 || (stats.psi.attempted > 0 && stats.psi.ok === 0));
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
