// The one Gemini budget accountant (owner decisions 2026-11-10, "people
// first, AI with the leftovers"). Every job that calls Gemini asks here how
// many requests it may spend now; the answer comes from what the
// gemini_requests table says was spent since the quota day began.
//
// The quota day: Google's free quota resets at midnight Pacific
// (America/Los_Angeles), so "today" is the Pacific calendar day, 23 or 25
// hours long on the two DST days. Every time here is a real instant (UTC ISO
// in the database); only the day boundaries and the schedule are Pacific.
//
// Who gets what (3.5 Flash-Lite, 500 a day):
//   - People ("grade my portfolio", re-grade requests; jobs named people-*)
//     run as they arrive, with the whole day's quota minus an evening
//     reserve; from the start of the end-of-day run they may use the reserve
//     too (peopleAllowance).
//   - Background AI runs once a night, at the end of the quota day, on what
//     is left, in STAGES order, each stage with a request cap and a
//     wall-clock cap (pipeline/night.mjs). It always leaves the reserve,
//     which grows with human demand: max(reserve, demandFactor x people's
//     requests in the last hour) (backgroundAllowance).
//   - Human face-off votes use no Gemini and are never scheduled.
//
// Settings: GEMINI_BUDGET (JSON, merged over DEFAULT_PLAN; a Worker var in
// wrangler.jsonc and a repository variable for the Actions fallback),
// GEMINI_DAILY_QUOTA (pipeline/gemini-log.mjs) and GEMINI_RPM.
import { PRIMARY_MODEL } from "./gemini.mjs";

export const QUOTA_TZ = "America/Los_Angeles";

/**
 * The background stages, in priority order. `job` is what each stage writes
 * into gemini_requests.job, `label` what summaries and the admin view show.
 */
export const STAGES = [
  { key: "grade_new", job: "grade-new", label: "Grade new sites" },
  { key: "grade_changed", job: "grade-changed", label: "Grade changed sites" },
  { key: "compare", job: "compare", label: "AI ranking comparisons" },
  { key: "content", job: "content", label: "Content" },
  { key: "regrade", job: "regrade", label: "Re-grades (3.1 and older rubric)" },
  { key: "experiment", job: "experiment", label: "Experiments" },
];

/** Jobs that serve a person who is waiting. They always come before the background. */
export const PEOPLE_JOBS = { "people-grade": "Grade my portfolio (people)", "people-regrade": "Re-grade requests (people)" };
export const isPeopleJob = (job) => /^people-/.test(String(job ?? ""));

// Older job names in gemini_requests, counted against the stage that does
// that work today: judge.mjs logged every grade as "rubric" and every
// ELO-era AI vote as "pairwise".
const JOB_ALIASES = { rubric: "grade-new", pairwise: "compare", "eval-rubric": "experiment" };
export const canonicalJob = (job) => JOB_ALIASES[job] ?? String(job ?? "unknown");

const LABELS = {
  ...Object.fromEntries(STAGES.map((s) => [s.job, s.label])),
  ...PEOPLE_JOBS,
};
export const jobLabel = (job) => LABELS[canonicalJob(job)] ?? canonicalJob(job);

export const DEFAULT_PLAN = {
  model: PRIMARY_MODEL,
  // Kept back from the background for people who arrive late at night.
  reserve: 25,
  // The reserve grows with demand: this many times people's requests in the last hour.
  demandFactor: 2,
  // People who requested in the last activeMinutes pause the background for pauseMinutes.
  activeMinutes: 10,
  pauseMinutes: 5,
  // The background works in batches of at most this many requests and
  // re-reads the quota and people's demand before each one.
  batch: 20,
  // The end-of-day run starts at this Pacific time (the Worker's cron fires
  // in UTC at both possible offsets, see isNightStart).
  startHour: 20,
  startMinute: 30,
  // The free checks (capture, fingerprints) get this long before the AI stages start anyway.
  checksMinutes: 45,
  // Nothing starts later than this many minutes before the quota resets.
  stopBeforeResetMinutes: 30,
  // At most this many retries (5xx, timeouts, rate limits) in one night.
  retryBudget: 20,
  // This many failures in a row stop a stage for the night.
  breaker: 5,
  // An item that fails on this many nights in a row is parked, not retried.
  parkAfterNights: 3,
  // Per stage: a request cap (counted over the whole quota day, retries
  // included) and a wall-clock cap in minutes. Caps add up to more than
  // the quota on purpose: what is left after people decides.
  stages: {
    grade_new: { cap: 300, minutes: 60 },
    grade_changed: { cap: 100, minutes: 30 },
    compare: { cap: 200, minutes: 45 },
    content: { cap: 100, minutes: 30 },
    regrade: { cap: 300, minutes: 60 },
    experiment: { cap: 50, minutes: 15 },
  },
};

/** DEFAULT_PLAN with a GEMINI_BUDGET JSON override merged in (one level deep for stages). */
export function budgetPlan(raw = globalThis.process?.env?.GEMINI_BUDGET) {
  let over = {};
  try {
    over = raw ? JSON.parse(raw) : {};
  } catch {
    over = {};
  }
  const stages = { ...DEFAULT_PLAN.stages };
  for (const [k, v] of Object.entries(over.stages ?? {})) stages[k] = { ...(stages[k] ?? { cap: 0, minutes: 0 }), ...v };
  return { ...DEFAULT_PLAN, ...over, stages };
}

// ---------------------------------------------------------------------------
// Pacific time
// ---------------------------------------------------------------------------
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The Pacific wall-clock parts of an instant: { year, month, day, hour, minute, weekday (0 = Sunday) }. */
export function pacificParts(at) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

const pad = (n) => String(n).padStart(2, "0");

// The instant of midnight Pacific that starts the given calendar day: 07:00
// UTC under daylight time, 08:00 UTC under standard time. DST changes at
// 2 am, so midnight itself is never ambiguous.
function pacificMidnight(year, month, day) {
  for (const offset of [7, 8]) {
    const t = new Date(Date.UTC(year, month - 1, day, offset));
    const p = pacificParts(t);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0) return t;
  }
  throw new Error(`no Pacific midnight on ${year}-${month}-${day}`);
}

/**
 * The Gemini quota day an instant falls in: { day: "YYYY-MM-DD" (Pacific),
 * start, end } where start and end are the Date instants of the midnights
 * that bound it.
 */
export function quotaDay(at = new Date()) {
  const p = pacificParts(at);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return {
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    start: pacificMidnight(p.year, p.month, p.day),
    end: pacificMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/** The Pacific day before `day` ("YYYY-MM-DD"). */
export function previousDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Should a cron firing at `scheduledTime` start tonight's run? Cron Triggers
 * run in UTC, so the Worker has one cron per possible offset (03:30 and
 * 04:30 UTC = 20:30 Pacific under daylight and standard time); only the one
 * that lands on startHour:startMinute Pacific starts the run.
 * Returns { start, night, local } with `local` the Pacific time as "HH:MM".
 */
export function isNightStart(scheduledTime, plan = DEFAULT_PLAN) {
  const p = pacificParts(scheduledTime);
  return {
    start: p.hour === plan.startHour && p.minute === plan.startMinute,
    night: quotaDay(scheduledTime).day,
    local: `${pad(p.hour)}:${pad(p.minute)}`,
    sunday: p.weekday === 0,
  };
}

/** The UTC cron expressions that cover startHour:startMinute Pacific in both DST states. */
export function nightCrons(plan = DEFAULT_PLAN) {
  return [7, 8].map((offset) => `${plan.startMinute} ${(plan.startHour + offset) % 24} * * *`);
}

/**
 * Tonight's timeline: when the AI stages start at the latest (after the free
 * checks) and the hard stop before the quota reset.
 */
export function nightTimeline(startedAt, plan = DEFAULT_PLAN) {
  const { day, end } = quotaDay(startedAt);
  const t0 = new Date(startedAt).getTime();
  return {
    night: day,
    checksDeadline: new Date(t0 + plan.checksMinutes * 60000).toISOString(),
    hardStop: new Date(end.getTime() - plan.stopBeforeResetMinutes * 60000).toISOString(),
    reset: end.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Usage and allowances
// ---------------------------------------------------------------------------

/**
 * What the quota day has used so far, from gemini_requests:
 * { day, start, end, byModel: {model: n}, byJob: {job: {model: n}},
 *   peopleLastHour, peopleRecent } (people's requests in the last hour and
 * in the last plan.activeMinutes).
 */
/**
 * @param {{ execute: Function }} db
 * @param {{ now?: Date, plan?: typeof DEFAULT_PLAN }} [options]
 */
export async function usageToday(db, { now = new Date(), plan = DEFAULT_PLAN } = {}) {
  const at = new Date(now);
  const { day, start, end } = quotaDay(at);
  const res = await db.execute({
    sql: `SELECT job, model, COUNT(*) AS n FROM gemini_requests WHERE at >= ? AND at < ? GROUP BY job, model`,
    args: [start.toISOString(), end.toISOString()],
  });
  const byModel = {};
  const byJob = {};
  for (const r of res.rows) {
    const model = String(r.model);
    const job = canonicalJob(r.job);
    const n = Number(r.n);
    byModel[model] = (byModel[model] ?? 0) + n;
    byJob[job] ??= {};
    byJob[job][model] = (byJob[job][model] ?? 0) + n;
  }
  const people = await db.execute({
    sql: `SELECT SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS hour,
                 SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS recent
          FROM gemini_requests WHERE at >= ? AND at <= ? AND job LIKE 'people-%'`,
    args: [
      new Date(at.getTime() - 3600000).toISOString(),
      new Date(at.getTime() - plan.activeMinutes * 60000).toISOString(),
      new Date(at.getTime() - 3600000).toISOString(),
      at.toISOString(),
    ],
  });
  return {
    day,
    start: start.toISOString(),
    end: end.toISOString(),
    byModel,
    byJob,
    peopleLastHour: Number(people.rows[0]?.hour ?? 0),
    peopleRecent: Number(people.rows[0]?.recent ?? 0),
  };
}

/** The reserve the background must leave: it grows with people's demand in the last hour. */
/** @type {(usage: { peopleLastHour?: number }, plan?: typeof DEFAULT_PLAN) => number} */
export const reserveFor = (usage, plan = DEFAULT_PLAN) => Math.max(plan.reserve, plan.demandFactor * (usage.peopleLastHour ?? 0));

/**
 * How many requests a background stage may spend now:
 * min(its cap minus what it used today, the quota left minus the reserve).
 * Returns { allowed, remaining, reserve, used, cap, limitedBy } where
 * limitedBy is "cap" or "quota" when allowed is 0.
 * @param {string} stageKey
 * @param {{ byModel: Record<string, number>, byJob: Record<string, Record<string, number>>, peopleLastHour?: number }} usage
 * @param {{ plan?: typeof DEFAULT_PLAN, quota?: Record<string, number> }} [options]
 */
export function backgroundAllowance(stageKey, usage, { plan = DEFAULT_PLAN, quota = {} } = {}) {
  const stage = STAGES.find((s) => s.key === stageKey);
  if (!stage) throw new Error(`unknown stage ${stageKey}`);
  const model = plan.model;
  const remaining = (quota?.[model] ?? 0) - (usage.byModel[model] ?? 0);
  const reserve = reserveFor(usage, plan);
  const used = usage.byJob[stage.job]?.[model] ?? 0;
  const cap = plan.stages[stageKey]?.cap ?? 0;
  const byCap = cap - used;
  const byQuota = remaining - reserve;
  const allowed = Math.max(0, Math.min(byCap, byQuota));
  return { allowed, remaining, reserve, used, cap, limitedBy: allowed > 0 ? null : byCap <= byQuota ? "cap" : "quota" };
}

/**
 * How many requests people may spend now: everything left, minus the
 * reserve until the end-of-day run starts (the reserve is for people who
 * come late), then all of it.
 * @param {{ byModel: Record<string, number> }} usage
 * @param {{ plan?: typeof DEFAULT_PLAN, quota?: Record<string, number>, now?: Date }} [options]
 */
export function peopleAllowance(usage, { plan = DEFAULT_PLAN, quota = {}, now = new Date() } = {}) {
  const model = plan.model;
  const remaining = (quota?.[model] ?? 0) - (usage.byModel[model] ?? 0);
  const p = pacificParts(now);
  const evening = p.hour * 60 + p.minute >= plan.startHour * 60 + plan.startMinute;
  return Math.max(0, remaining - (evening ? 0 : plan.reserve));
}

// ---------------------------------------------------------------------------
// Re-grade requests (people): a cooldown, sooner when the page changed
// ---------------------------------------------------------------------------
export const REGRADE_COOLDOWN_DAYS = 7;

/**
 * May a person's site be re-graded now? Once every REGRADE_COOLDOWN_DAYS,
 * or at once when its page fingerprint changed after the last grade.
 * Returns { allowed, reason, nextAt } (nextAt an ISO time, or null).
 */
export function regradeAllowed({ lastGradedAt, pageChangedAt = null, now = new Date(), cooldownDays = REGRADE_COOLDOWN_DAYS }) {
  if (!lastGradedAt) return { allowed: true, reason: "never graded", nextAt: null };
  const last = new Date(lastGradedAt).getTime();
  if (pageChangedAt && new Date(pageChangedAt).getTime() > last) return { allowed: true, reason: "page changed since the last grade", nextAt: null };
  const next = last + cooldownDays * 86400000;
  if (new Date(now).getTime() >= next) return { allowed: true, reason: "cooldown over", nextAt: null };
  return { allowed: false, reason: `re-graded at most once every ${cooldownDays} days`, nextAt: new Date(next).toISOString() };
}

// ---------------------------------------------------------------------------
// The admin quota view (app/api/admin/quota)
// ---------------------------------------------------------------------------

/**
 * Requests per quota day, job and model for the last `days` days (today
 * included): { timezone, quota, today, days } where each day is
 * { day, total: {model: n}, jobs: [{ job, label, model, requests, ok }] },
 * newest first.
 * @param {{ execute: Function }} db
 * @param {{ now?: Date, days?: number, quota?: Record<string, number> }} [options]
 */
export async function usageHistory(db, { now = new Date(), days = 30, quota = {} } = {}) {
  const today = quotaDay(now);
  // The first day's midnight: step back day by day so DST is respected.
  let first = today;
  for (let i = 1; i < days; i++) first = quotaDay(new Date(first.start.getTime() - 3600000));
  const res = await db.execute({
    sql: `SELECT substr(at, 1, 13) AS hour, job, model, COUNT(*) AS n,
                 SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS ok
          FROM gemini_requests WHERE at >= ? AND at < ?
          GROUP BY hour, job, model`,
    args: [first.start.toISOString(), today.end.toISOString()],
  });
  const byDay = new Map();
  for (const r of res.rows) {
    const day = quotaDay(new Date(`${r.hour}:00:00Z`)).day;
    const job = canonicalJob(r.job);
    const model = String(r.model);
    const d = byDay.get(day) ?? { day, total: {}, jobs: new Map() };
    d.total[model] = (d.total[model] ?? 0) + Number(r.n);
    const key = `${job}\n${model}`;
    const j = d.jobs.get(key) ?? { job, label: jobLabel(job), model, requests: 0, ok: 0 };
    j.requests += Number(r.n);
    j.ok += Number(r.ok ?? 0);
    d.jobs.set(key, j);
    byDay.set(day, d);
  }
  const list = [];
  let d = today;
  for (let i = 0; i < days; i++) {
    const e = byDay.get(d.day) ?? { day: d.day, total: {}, jobs: new Map() };
    list.push({ day: e.day, total: e.total, jobs: [...e.jobs.values()].sort((a, b) => b.requests - a.requests) });
    d = quotaDay(new Date(d.start.getTime() - 3600000));
  }
  return { timezone: QUOTA_TZ, quota, today: list[0], days: list };
}
