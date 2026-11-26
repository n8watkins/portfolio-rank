// The prewarm loop, separate from scripts/prewarm-metrics.mjs so tests can
// drive it with stand-ins. For each site it calls the site's own /api/inspect
// (which fills the polish cache) and measures Lighthouse itself: `measure`
// (lib/psi-job.mjs measureAndStore) calls PageSpeed from the job's runner and
// writes the results to the database. It counts what worked per kind, and
// decides the exit code: red when the job could not do its work (no key, a key
// Google refuses, the day's quota spent before anything was measured, every
// measure failing, a long streak of per-minute refusals), green otherwise,
// however many sites fail once the backlog is done (the counts are in the summary).

import { GEMINI_YES_SQL, SIGNALS_SQL } from "../../lib/tiers-store.mjs";
import { STRONG_SIGNALS } from "../../pipeline/portfolio-guard.mjs";
import { FRESHNESS_TABLES, dueSql } from "../../lib/freshness.mjs";
import { hiddenWhereOf } from "../../lib/hidden.mjs";
import { ownerMarks } from "../../lib/ownership/same-site.mjs";
import { PSI_CALL_TABLES } from "../../lib/psi-calls.mjs";
import { BACKOFF_DAYS, FAILED_RETRY_MS, PREWARM_CONCURRENCY, backoffMs, pacing } from "../../lib/psi-pacing.mjs";

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
// A try of a device that ends without a new stored result (a failed measure,
// or one run against a stored average) is noted (psi_attempts: when, and how
// many in a row), and that device waits 1 day, then 3, then 7, then 30 before
// it is tried again (BACKOFF_DAYS), so a site whose device keeps failing never
// holds the front of the queue: it costs two runs a device on days 0, 1, 4, 11,
// 41, then every 30 days, and untried sites sort before retried ones. A
// forced re-measure (the admin's Re-measure, an owner's Re-check) is tried
// once at once, then follows the same backoff; a new stored result clears the
// count. 100 sites failing on both devices cost 400 runs on their
// first day, 400 more on days 1, 4, 11 and 41, then about 13 runs a day on average.
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
 * live, not hidden (not working, dead, parked), not removed by their owner, not
 * graded "not a portfolio", and a library member or one by the membership rule
 * (lib/tiers-store.mjs libraryMember): Gemini said "a portfolio", or a
 * captured site with measured facts and at least STRONG_SIGNALS of the six
 * portfolio signals, or a member already (the owner kept it), so every member
 * gets its own Lighthouse whether Gemini graded it or not (owner, 2026-11-22:
 * the Starting rank comes from code).
 * A device (phone: "psi:<url>", desktop: "psi-desktop:<url>") is due when it
 * has no result, the admin or an owner asked for a re-measure after it
 * (lib/freshness.mjs dueSql "lighthouse"), its good result is older than 90
 * days or is one run (stored before two runs a device, or by a visitor's
 * speed check), or its result is a failure older than FAILED_RETRY_MS, and it
 * is not waiting out its backoff after failed tries (psi_attempts; a re-measure
 * asked for after the last try is tried at once). A site is returned with only
 * the devices that are due, so a site whose phone result is fresh and desktop
 * is missing costs two runs, not four.
 * Order: re-measures asked for and not yet tried first, then sites never tried
 * (never measured first, then the oldest), then retried sites.
 * @param {{ execute: Function }} db
 * @param {{ active: (p: string) => string, limit?: number, now?: number }} options
 * @returns {Promise<{ url: string, devices: ("mobile" | "desktop")[] }[]>}
 */
export async function prewarmQueue(db, { active, limit = PREWARM_LIMIT, now = Date.now() }) {
  // The admin's "Re-measure" requests (site_freshness) and the tries (psi_attempts) are read below; a database that never had them has none.
  for (const sql of [...FRESHNESS_TABLES, ...PSI_CALL_TABLES]) await db.execute(sql);
  const tiers = (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_ratings'")).rows.length > 0;
  const member = tiers ? "OR EXISTS (SELECT 1 FROM tier_ratings t WHERE t.url = p.url AND t.member = 1)" : "";
  const t = Math.floor(Number(now));
  const wait = (a) => `CASE ${a}.fails ${BACKOFF_DAYS.map((_, i) => `WHEN ${i + 1} THEN ${backoffMs(i + 1)}`).join(" ")} ELSE ${backoffMs(BACKOFF_DAYS.length)} END`;
  // Waiting out a backoff: a try that failed is on record, no re-measure was asked for after it, and its wait has not passed.
  const backedOff = (a) => `(${a}.at IS NOT NULL AND NOT (COALESCE(f.forced_at, 0) > ${a}.at) AND ${a}.at > ${t} - (${wait(a)}))`;
  const dueDevice = (x, a) =>
    `((${dueSql("lighthouse", { at: `${x}.at`, failed: "0", now })} OR ${SINGLE_RUN(x)} OR (NOT ${GOOD(x)} AND ${x}.at <= ${t - FAILED_RETRY_MS})) AND NOT ${backedOff(a)})`;
  // A re-measure asked for after the result and after the last try of that device: tried promptly.
  const promptly = (x, a) => `(${x}.at IS NOT NULL AND f.forced_at > ${x}.at AND (${a}.at IS NULL OR f.forced_at > ${a}.at))`;
  const res = await db.execute({
    sql: `SELECT p.url, ${dueDevice("c", "am")} AS m, ${dueDevice("d", "ad")} AS d FROM portfolios p
          LEFT JOIN cache c ON c.k = 'psi:' || p.url
          LEFT JOIN cache d ON d.k = 'psi-desktop:' || p.url
          LEFT JOIN psi_attempts am ON am.url = p.url AND am.device = 'mobile'
          LEFT JOIN psi_attempts ad ON ad.url = p.url AND ad.device = 'desktop'
          LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")}
            AND NOT (${hiddenWhereOf("p")})
            AND NOT (CASE WHEN json_valid(p.ai_rubric) THEN COALESCE(json_extract(p.ai_rubric, '$.is_portfolio') = 0, 0) ELSE 0 END)
            AND (${GEMINI_YES_SQL("p")}
              OR (p.shot_key IS NOT NULL AND COALESCE(json_valid(p.facts), 0) AND ${SIGNALS_SQL("p")} >= ${STRONG_SIGNALS})
              ${member})
            AND (${dueDevice("c", "am")} OR ${dueDevice("d", "ad")})
          ORDER BY CASE WHEN ${promptly("c", "am")} OR ${promptly("d", "ad")} THEN 0 ELSE 1 END,
                   CASE WHEN am.at IS NULL AND ad.at IS NULL THEN 0 ELSE 1 END,
                   c.at IS NOT NULL, COALESCE(c.at, 0), MIN(COALESCE(am.at, ad.at), COALESCE(ad.at, am.at)), p.url`,
    args: [],
  });
  // Sites whose owner removed them are not measured (as /api/psi never showed them); applied here, then the limit.
  const marks = await ownerMarks(db, { fresh: true });
  return res.rows
    .filter((r) => !marks.isRemoved(String(r.url)))
    .slice(0, limit)
    .map((r) => ({ url: String(r.url), devices: [...(Number(r.m) ? ["mobile"] : []), ...(Number(r.d) ? ["desktop"] : [])] }));
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
  // Set when PageSpeed refuses everything (the day's quota, a key it will not take) or keeps refusing per minute: no
  // site is started after that, since every measure would be refused too. { text, kind } with kind "quota", "api_key" or "rate".
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
          if (r.error === "api_key") stopped ??= { kind: "api_key", text: `PageSpeed refused the key at site ${i + 1} of ${urls.length}: the PSI_API_KEY secret is invalid, or restricted so that GitHub runners are blocked (an IP address or referrer restriction in the Google Cloud console). Replace the PSI_API_KEY Actions secret or loosen its restriction` };
          else if (r.error === "quota") stopped ??= { kind: "quota", text: `PageSpeed refused the day's quota at site ${i + 1} of ${urls.length}` };
          else if (rateLimited >= RATE_LIMITED_STREAK_STOP) stopped ??= { kind: "rate", text: `PageSpeed kept refusing for its per-minute limit for ${rateLimited} sites in a row (at site ${i + 1} of ${urls.length})` };
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
  const topOf = (errors) => Object.entries(errors).sort((a, b) => b[1] - a[1])[0];

  const notStarted = Math.max(0, urls.length - next);
  // Red when the job could not do its work, not because many sites fail: a key Google refuses, a streak of per-minute
  // refusals, the day's quota spent before anything was measured, every measure failing, every polish check failing.
  // The share of failing sites does not matter (the counts are in the summary): once the backlog is done, some sites always fail.
  const quotaFirst = stopped?.kind === "quota" && stats.psi.ok === 0;
  const stopRed = stopped && (stopped.kind !== "quota" || quotaFirst);
  const allPsiFailed = stats.psi.attempted > 0 && stats.psi.ok === 0;
  const allInspectFailed = stats.inspect.attempted > 0 && stats.inspect.ok === 0;
  const red = Boolean(stopRed || allPsiFailed || allInspectFailed);
  const verdict = attempted === 0
    ? "Nothing to prewarm."
    : stopped
      ? `STOPPED: ${stopped.text}; ${notStarted} site(s) not tried; ${stats.psi.ok} measured.`
      : allPsiFailed
        ? `FAILED: every Lighthouse measure failed (${stats.psi.attempted} tried; most common error: ${topOf(stats.psi.errors)[0]} (${topOf(stats.psi.errors)[1]})).`
        : allInspectFailed
          ? `FAILED: every polish check failed (${stats.inspect.attempted} tried; most common error: ${topOf(stats.inspect.errors)[0]} (${topOf(stats.inspect.errors)[1]})).`
          : `OK: ${ok} of ${attempted} lookups succeeded${failed ? `, ${failed} did not (most common error: ${top[0]} (${top[1]}))` : ""}.`;

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

  return { exitCode: red ? 1 : 0, stats, summary, verdict };
}
