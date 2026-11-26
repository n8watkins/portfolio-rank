// One PageSpeed Insights (Lighthouse) call and how its answer is read: the
// code the Worker (the visitor speed tool, Add and Re-check, lib/tools/psi.ts)
// and the daily prewarm job (scripts/prewarm-metrics.mjs, lib/psi-job.mjs)
// share, so a result means the same thing whoever measured it. Plain
// JavaScript with no imports from the app, so Node and the Worker both load it.
//
// PSI_API_KEY is a key in a Google project with no billing account: 25,000
// runs a day, and past that Google refuses instead of charging. Keyless calls
// have a quota of zero today, so without the key every run fails.

import { fixFor } from "./psi-fixes.mjs";

/** The Lighthouse categories requested and stored, in the order the product shows them. */
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

const METRICS = [
  { id: "largest-contentful-paint", label: "Largest Contentful Paint" },
  { id: "first-contentful-paint", label: "First Contentful Paint" },
  { id: "total-blocking-time", label: "Total Blocking Time" },
  { id: "cumulative-layout-shift", label: "Cumulative Layout Shift" },
  { id: "speed-index", label: "Speed Index" },
];

const MAX_FIXES = 6;

/** The failing audits of a Lighthouse result that have a plain-words fix, biggest win first. */
export function pickFixes(lhr) {
  const out = [];
  const seen = new Set();
  for (const category of CATEGORIES) {
    for (const ref of lhr.categories?.[category]?.auditRefs ?? []) {
      if (seen.has(ref.id) || ref.group === "metrics" || ref.group === "hidden") continue;
      const a = lhr.audits?.[ref.id];
      if (!a || typeof a.score !== "number" || a.score >= 0.9) continue;
      if (a.scoreDisplayMode === "notApplicable" || a.scoreDisplayMode === "manual" || a.scoreDisplayMode === "informative") continue;
      const tip = fixFor(ref.id);
      if (!tip) continue;
      seen.add(ref.id);
      const savedMs = Object.values(a.metricSavings ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
      // Speed fixes rank by time saved; the others by the weight Lighthouse gives them, after a fast win.
      const rank = category === "performance" ? savedMs + (1 - a.score) * 100 : (ref.weight ?? 1) * 40;
      out.push({ id: ref.id, title: tip.title ?? a.title ?? ref.id, savings: a.displayValue || undefined, tip: tip.tip, category, rank });
    }
  }
  return out
    .sort((x, y) => y.rank - x.rank)
    .slice(0, MAX_FIXES)
    .map(({ rank, ...f }) => (void rank, f));
}

/**
 * Turns one PageSpeed response into the stored result of a single run.
 * @param {any} data the response body
 * @param {"mobile" | "desktop"} strategy
 * @returns {any}
 */
export function readPsi(data, strategy) {
  const lhr = data?.lighthouseResult;
  if (!lhr) return { ok: false, error: "no_data", strategy };
  const scores = {};
  for (const id of CATEGORIES) {
    const raw = lhr.categories?.[id]?.score;
    scores[id] = typeof raw === "number" ? Math.round(raw * 100) : null;
  }
  const metrics = METRICS.flatMap(({ id, label }) => {
    const a = lhr.audits?.[id];
    return a?.displayValue ? [{ id, label, value: a.displayValue.replace(/ /g, " "), score: typeof a.score === "number" ? a.score : null, numeric: typeof a.numericValue === "number" ? a.numericValue : null }] : [];
  });
  // From audits the same run already returns (no extra request).
  const bytes = lhr.audits?.["total-byte-weight"]?.numericValue;
  const requests = lhr.audits?.["network-requests"]?.details?.items?.length;
  const weight = { bytes: typeof bytes === "number" ? Math.round(bytes) : null, requests: typeof requests === "number" ? requests : null };
  return {
    ok: true,
    strategy,
    scores,
    metrics,
    fixes: pickFixes(lhr),
    weight,
    ...(lhr.finalDisplayedUrl ? { finalUrl: lhr.finalDisplayedUrl } : {}),
    runs: 1,
    runsAttempted: 1,
    runScores: [scores.performance],
    ranAt: new Date().toISOString(),
    ...(lhr.fetchTime ? { fetchedAt: lhr.fetchTime } : {}),
  };
}

/**
 * What a refused call (HTTP 429) was: "quota" is the day's quota (nothing more
 * runs until it resets), "rate_limited" a per-minute (or per-100-seconds)
 * limit that clears by itself. Google's message names the limit ("... limit
 * 'Queries per day' ..."); a message that does not say "per day" or "daily" is
 * treated as the per-minute kind, which is retried a few times and never stops
 * a job on its own. (Google's exact wording is not verified here.)
 */
export function classifyRefusal(message) {
  return /per day|daily|per-day/i.test(String(message ?? "")) ? "quota" : "rate_limited";
}

/**
 * Whether a 400 or 403 answer is about the API key (invalid, restricted to
 * other IP addresses or referrers, or the API not allowed for it) rather than
 * about the site. Google's exact wording is not verified here: "API key" in the
 * message or an API_KEY_ reason is what is relied on, plus "blocked",
 * "permission", "referrer" or "not been used" for a 403.
 */
export function isKeyProblem(message, reasons, status) {
  const text = `${message} ${reasons}`;
  if (/api[ _-]?key/i.test(text)) return true;
  return status === 403 && /blocked|permission|not been used|disabled|referer|referrer/i.test(text);
}

/**
 * One PageSpeed run. Never throws: a quota, rate limit, timeout or site error
 * is { ok: false, error }.
 * @param {string} target the address to measure
 * @param {"mobile" | "desktop"} strategy
 * @param {{ key?: string, base?: string, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function runPsiCall(target, strategy, { key = process.env.PSI_API_KEY, base = process.env.PSI_API_BASE, fetchFn = fetch, timeoutMs = 90_000 } = {}) {
  try {
    // PSI_API_BASE points the end-to-end tests at a local stand-in for Google.
    const psiUrl = new URL(base || "https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    psiUrl.searchParams.set("url", target);
    psiUrl.searchParams.set("strategy", strategy);
    if (key) psiUrl.searchParams.set("key", key);
    for (const cat of CATEGORIES) psiUrl.searchParams.append("category", cat);
    const res = await fetchFn(psiUrl.toString(), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = String(err?.error?.message ?? "");
      const reasons = (Array.isArray(err?.error?.details) ? err.error.details : []).map((d) => String(d?.reason ?? "")).join(" ");
      // 429 is a quota (the day's, or a per-minute limit); a 400 or 403 that talks about the key is the key being
      // invalid or restricted (nothing about the site); other 400s and 500s usually mean Lighthouse couldn't load the page.
      const keyProblem = (res.status === 400 || res.status === 403) && isKeyProblem(message, reasons, res.status);
      const error = res.status === 429 ? classifyRefusal(message) : keyProblem ? "api_key" : res.status >= 500 || res.status === 400 ? "unreachable" : `psi_${res.status}`;
      console.log(JSON.stringify({ event: "psi.error", status: res.status, strategy, message: message.slice(0, 200) }));
      return { ok: false, error, strategy };
    }
    return readPsi(await res.json(), strategy);
  } catch (e) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "fetch_error", strategy };
  }
}
