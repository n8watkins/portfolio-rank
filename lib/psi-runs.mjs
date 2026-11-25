// Several Lighthouse runs of one device, kept as one stored result (pure, no
// network). A site's profile shows the average of two runs per device, and
// says so with methodSentence(); a result that holds one run (an older stored
// row, a run where the other failed, a visitor's speed check) is never
// presented as an average.
//
// What a stored result carries on top of the old single-run shape:
//   runs          how many runs succeeded and went into the numbers (1 or 2)
//   runsAttempted how many were made (the quota used)
//   runScores     the performance score of each attempted run, null where it failed
//   ranAt         when it was measured (ISO 8601)
// A row without `runs` is one run (an old row): see runCount().

/** Lighthouse runs per device, per site measure (two phone, two desktop). */
export const RUNS_PER_DEVICE = 2;

/** The Lighthouse categories PageSpeed returns, in the order the product shows them. */
const CATEGORY_IDS = ["performance", "accessibility", "best-practices", "seo"];

const SECONDS_METRICS = new Set(["largest-contentful-paint", "first-contentful-paint", "speed-index"]);

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const nums = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));

/** How many runs a stored result holds: `runs`, or 1 for a row stored before runs were counted. */
export function runCount(result) {
  if (!result || result.ok !== true) return 0;
  const n = result.runs;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** The text of one metric from its averaged raw value (milliseconds, or unitless for layout shift), in Lighthouse's style. */
export function formatMetric(id, value) {
  if (SECONDS_METRICS.has(id)) return `${(Math.round(value / 100) / 10).toFixed(1)} s`;
  if (id === "total-blocking-time") return `${Math.round(value / 10) * 10} ms`;
  if (id === "cumulative-layout-shift") return String(Number(value.toFixed(3)));
  return String(Math.round(value));
}

/**
 * One result from the runs of a device. Failed runs are left out of the
 * numbers; a run that is the same Lighthouse run as an earlier one
 * (same `fetchedAt`: the same Lighthouse run) counts once.
 * Never throws. With one good run, that run is returned as it was, marked
 * runs: 1; with none, the first failure.
 * @param {any[]} results the PsiResult of each run, in order
 * @param {{ strategy?: string, now?: Date }} [opts]
 */
export function averageRuns(results, { strategy, now = new Date() } = {}) {
  const attempted = results.length;
  const seen = new Set();
  const good = [];
  /** @type {(number | null)[]} */
  const runScores = [];
  for (const r of results) {
    const dup = r?.ok === true && r.fetchedAt != null && seen.has(r.fetchedAt);
    if (r?.ok === true && !dup) {
      if (r.fetchedAt != null) seen.add(r.fetchedAt);
      good.push(r);
      runScores.push(typeof r.scores?.performance === "number" ? r.scores.performance : null);
    } else runScores.push(null);
  }
  const ranAt = now.toISOString();
  if (!good.length) {
    const failed = results.find((r) => r && r.ok !== true) ?? { ok: false, error: "no_data", strategy };
    return { ...failed, strategy: failed.strategy ?? strategy, runs: 0, runsAttempted: attempted, runScores, ranAt };
  }
  if (good.length === 1) return { ...good[0], runs: 1, runsAttempted: attempted, runScores, ranAt };

  const scores = {};
  for (const id of CATEGORY_IDS) {
    const xs = nums(good.map((r) => r.scores?.[id]));
    scores[id] = xs.length ? Math.round(mean(xs)) : null;
  }
  const metricIds = [];
  for (const r of good) for (const m of r.metrics ?? []) if (!metricIds.includes(m.id)) metricIds.push(m.id);
  const metrics = metricIds.map((id) => {
    const each = good.map((r) => (r.metrics ?? []).find((m) => m.id === id)).filter(Boolean);
    const raw = nums(each.map((m) => m.numeric));
    const sc = nums(each.map((m) => m.score));
    const first = each[0];
    // Without raw values (a run stored before they were kept) the first run's text stands.
    const value = raw.length === each.length ? formatMetric(id, mean(raw)) : first.value;
    return { id, label: first.label, value, score: sc.length ? mean(sc) : null, ...(raw.length === each.length ? { numeric: mean(raw) } : {}) };
  });
  const bytes = nums(good.map((r) => r.weight?.bytes));
  const requests = nums(good.map((r) => r.weight?.requests));
  const weight = { bytes: bytes.length ? Math.round(mean(bytes)) : null, requests: requests.length ? Math.round(mean(requests)) : null };
  const { fixes, finalUrl } = good[0];
  return { ok: true, strategy: good[0].strategy ?? strategy, scores, metrics, fixes, weight, ...(finalUrl ? { finalUrl } : {}), runs: good.length, runsAttempted: attempted, runScores, ranAt };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One device, measured `runs` times one after the other and averaged. The
 * wait between runs is a precaution against the second run being the first
 * again (not based on a documented PageSpeed rule; averageRuns counts a
 * repeated run once anyway).
 * A refused quota stops the device at once: more runs would be refused too.
 * Never throws if `run` does not.
 * @param {string} target
 * @param {"mobile" | "desktop"} strategy
 * @param {{ run: (target: string, strategy: "mobile" | "desktop") => Promise<any>, runs?: number, gapMs?: number, sleep?: (ms: number) => Promise<void> }} o
 */
export async function measureDevice(target, strategy, { run, runs = RUNS_PER_DEVICE, gapMs = 0, sleep = defaultSleep }) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    const r = await run(target, strategy);
    results.push(r);
    if (r && r.ok !== true && r.error === "quota") break;
  }
  return averageRuns(results, { strategy });
}

/**
 * A site's measure: two runs on a phone and two on desktop, the two devices
 * side by side, averaged per device.
 * @param {string} target
 * @param {Parameters<typeof measureDevice>[2]} o
 */
export async function measureSite(target, o) {
  const [mobile, desktop] = await Promise.all([measureDevice(target, "mobile", o), measureDevice(target, "desktop", o)]);
  return { mobile, desktop };
}

const MONTHS =["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "25 Nov 2026" (UTC) from an ISO date or a time in ms, or null. */
function dayOf(v) {
  if (v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The sentence a profile may show about how a device's Lighthouse numbers were
 * measured: "Two Lighthouse runs on 25 Nov 2026, averaged" or "One Lighthouse
 * run on 25 Nov 2026". Null when there is no good result. A row stored before
 * runs were counted reads as one run. The date is when it was measured
 * (`ranAt`, else the cache's `measuredAt`); without any date it is left out.
 */
export function methodSentence(result) {
  const n = runCount(result);
  if (n === 0) return null;
  const day = dayOf(result.ranAt ?? result.measuredAt);
  const on = day ? ` on ${day}` : "";
  if (n === 1) return `One Lighthouse run${on}`;
  const word = n === 2 ? "Two" : String(n);
  return `${word} Lighthouse runs${on}, averaged`;
}

/** The method sentence of each device: { mobile, desktop }, each a string or null. */
export function methodSentences({ mobile = null, desktop = null } = {}) {
  return { mobile: methodSentence(mobile), desktop: methodSentence(desktop) };
}

/** Whether a stored result should be measured again for having fewer runs than planned (an old or single-run row). */
export function needsMoreRuns(result) {
  if (!result || result.ok !== true) return false;
  const made = result.runsAttempted;
  return !(Number.isInteger(made) && made >= RUNS_PER_DEVICE);
}
