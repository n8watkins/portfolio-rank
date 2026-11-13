// The owner's goals (lib/goals/config.mjs): a weekly check, plain code and
// no Gemini, on the Monday-morning Cron Trigger ("0 16 * * 1", 8 or 9 am
// Pacific, worker/goals.ts).
//
// For the week that just finished (Monday to Monday, Pacific) it measures
// every metric, records each goal's progress in goal_progress, and when a
// goal is reached for the first time it records the event in goal_events and
// emails the owner through the owner-alert path (pipeline/alerts.mjs
// emailSender: the shared email gate, kind "owner-alert", to OWNER_EMAIL),
// with an .ics invite for a 30-minute decision slot a few days later. Once
// the email went out the goal never emails again; a send that failed is
// tried on the next check.
//
// Metrics, each as of the end of the finished week:
//   newsletter_confirmed  confirmed newsletter subscribers, from Kit's API
//                         (Kit keeps the list), as of the check; cached a
//                         day in the cache table (kit:confirmed). Unknown
//                         (null, never "reached") without KIT_API_KEY or
//                         when Kit doesn't answer and nothing is cached
//   graded_portfolios     portfolios in the library with an AI grade (listed,
//                         graded, and not judged "not a portfolio")
import { GOALS } from "../lib/goals/config.mjs";
import { GOAL_TABLES } from "../lib/goals/schema.mjs";
import { pacificParts, quotaDay } from "./quota-day.mjs";
import { NOT_PORTFOLIO } from "./roster.mjs";

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

export async function ensureGoalsSchema(db) {
  for (const sql of GOAL_TABLES) await db.execute(sql);
}

/** The Pacific midnight that starts the day `days` after the one containing `at` (negative goes back). */
function dayStart(at, days = 0) {
  // From noon of that day, whole days land inside the target day even
  // across a 23- or 25-hour DST day.
  return quotaDay(new Date(quotaDay(at).start.getTime() + 12 * 3600000 + days * DAY)).start;
}

/**
 * The finished week before `now`: { week (the Monday, "YYYY-MM-DD"), start,
 * end } with start and end the Pacific midnights that bound it. `back` = 1
 * gives the week before that.
 */
export function finishedWeek(now, back = 0) {
  const weekday = pacificParts(now).weekday; // 0 = Sunday
  const thisMonday = dayStart(now, -((weekday + 6) % 7));
  const start = dayStart(thisMonday, -7 * (back + 1));
  const end = dayStart(thisMonday, -7 * back);
  return { week: quotaDay(start).day, start, end };
}

async function count(db, sql, args = []) {
  try {
    return Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
  } catch (e) {
    // A table that doesn't exist yet counts 0.
    if (/no such table/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

const KIT_API = "https://api.kit.com/v4";
const KIT_CACHE_KEY = "kit:confirmed";

/**
 * Kit's confirmed (active) subscribers, cached a day in the cache table under
 * the same key and shape the app's admin pages use ({ count }). A failed call
 * falls back to the last cached count, else null.
 * @param {{ db: any, kitApiKey?: string | null, kitApi?: string, fetch?: typeof fetch }} ctx
 */
export async function kitConfirmed(ctx, { now = Date.now() } = {}) {
  if (!ctx.kitApiKey) return null;
  let cached = null;
  try {
    const row = (await ctx.db.execute({ sql: "SELECT v, at FROM cache WHERE k = ?", args: [KIT_CACHE_KEY] })).rows[0];
    const v = row ? JSON.parse(String(row.v)) : null;
    if (Number.isInteger(v?.count)) cached = { count: v.count, at: Number(row.at) };
  } catch {}
  if (cached && now - cached.at < DAY) return cached.count;
  try {
    const res = await (ctx.fetch ?? globalThis.fetch)(`${ctx.kitApi ?? KIT_API}/subscribers?status=active&include_total_count=true&per_page=1`, {
      headers: { "X-Kit-Api-Key": ctx.kitApiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`kit ${res.status}`);
    const data = await res.json();
    const n = Number(data?.pagination?.total_count ?? data?.total_count);
    if (!Number.isInteger(n)) throw new Error("kit count missing");
    await ctx.db.execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)", args: [KIT_CACHE_KEY, JSON.stringify({ count: n }), now] });
    return n;
  } catch (e) {
    ctx.log?.(`kit subscriber count failed: ${String(e?.message ?? e).slice(0, 120)}`);
    return cached?.count ?? null;
  }
}

/** Each metric for one finished week (weekly ones) or as of its end (totals). */
export const METRICS = {
  newsletter_confirmed: {
    label: "Confirmed newsletter subscribers (Kit)",
    // Kit's count today, for whichever week asks.
    read: (ctx) => kitConfirmed(ctx),
  },
  graded_portfolios: {
    label: "Graded portfolios in the library",
    // The library today: a grade only ever arrives, so "as of the week's end" is now.
    read: (ctx) => count(ctx.db, `SELECT COUNT(*) AS n FROM portfolios WHERE delisted_at IS NULL AND ai_rubric IS NOT NULL AND json_valid(ai_rubric) AND NOT ${NOT_PORTFOLIO("portfolios")}`),
  },
};

/**
 * Measures `goals` for the finished week before `now`, without writing:
 * [{ goal, week, reached, conditions: [{ ...condition, values: [this week,
 * the week before, ...], met }] }].
 * @param {{ db: any }} ctx
 */
export async function measureGoals(ctx, { now, goals = GOALS }) {
  const weeks = [finishedWeek(now, 0), finishedWeek(now, 1)];
  const cache = new Map();
  const read = async (metric, w) => {
    const key = `${metric}|${w.week}`;
    if (!cache.has(key)) cache.set(key, await METRICS[metric].read(ctx, w));
    return cache.get(key);
  };
  const out = [];
  for (const goal of goals) {
    const conditions = [];
    for (const c of goal.conditions) {
      const n = Math.max(1, c.weeks ?? 1);
      const values = [];
      for (let i = 0; i < n; i++) values.push(await read(c.metric, i === 0 ? weeks[0] : i === 1 ? weeks[1] : finishedWeek(now, i)));
      const met = values.every((v) => v != null && v >= c.atLeast);
      conditions.push({ ...c, values, met });
    }
    out.push({ goal, week: weeks[0].week, reached: conditions.some((c) => c.met), conditions });
  }
  return out;
}

/**
 * The decision slot: `daysLater` days after `now` (moved to Monday when it
 * lands on a weekend), at `hour`:00 Pacific, for `minutes`.
 */
export function decisionSlot(now, { daysLater = 3, hour = 10, minutes = 30 } = {}) {
  let day = dayStart(now, daysLater);
  const wd = pacificParts(day).weekday;
  if (wd === 6) day = dayStart(day, 2);
  else if (wd === 0) day = dayStart(day, 1);
  // Midnight plus the hour, corrected on the two days DST changes.
  let start = new Date(day.getTime() + hour * 3600000);
  start = new Date(start.getTime() + (hour - pacificParts(start).hour) * 3600000);
  return { start, end: new Date(start.getTime() + minutes * 60000) };
}

const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (d) => iso(d).replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds a content line at 75 octets (RFC 5545 3.1). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** An RFC 5545 calendar with one event (METHOD:PUBLISH, so any calendar adds it without an RSVP). */
export function buildIcs({ uid, start, end, summary, description, url, now }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PortfolioRank//Owner goals//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    ...(url ? [`URL:${url}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(summary)}`,
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .map(fold)
    .join("\r\n")
    .concat("\r\n");
}

const pacificLabel = (d) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);

/** What a reached goal's email says, with its .ics attachment. */
export function goalEmail(m, { now, slot, siteUrl }) {
  const { goal } = m;
  const lines = m.conditions.map((c) => {
    const shown = c.values.map((v) => (v == null ? "unknown" : v.toLocaleString("en-US"))).join(c.values.length > 1 ? " then " : "");
    return `${c.met ? "[reached]" : "[ ]      "} ${c.label}: ${shown}${c.values.length > 1 ? " (latest week first)" : ""}`;
  });
  const admin = siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/admin/goals` : null;
  const description = `${goal.why}\n\n${goal.meeting.agenda}${admin ? `\n\nProgress: ${admin}` : ""}`;
  const text = [
    `Goal reached: ${goal.title}.`,
    "",
    goal.why,
    "",
    `Week of ${m.week} (Monday to Monday, Pacific):`,
    ...lines,
    "",
    `A ${goal.meeting.minutes}-minute decision slot is attached for ${pacificLabel(slot.start)}. Move it if that time doesn't suit.`,
    "",
    "Agenda:",
    goal.meeting.agenda,
    ...(admin ? ["", `Progress on every goal: ${admin}`] : []),
    "",
    "This goal emails once; it won't fire again.",
  ].join("\n");
  const ics = buildIcs({ uid: `goal-${goal.id}@portfoliorank`, start: slot.start, end: slot.end, summary: goal.meeting.title, description, url: admin, now });
  return {
    subject: `Goal reached: ${goal.title}`,
    text,
    attachments: [{ filename: `${goal.id}.ics`, type: "text/calendar; charset=utf-8; method=PUBLISH", disposition: "attachment", content: ics }],
  };
}

/**
 * @typedef {{ metric: string, label: string, atLeast: number, weeks: number, values: (number | null)[], met: boolean }} ConditionResult
 * @typedef {{ to: string | null, subject: string, text: string, attachments: { filename: string, type: string, content: string }[] }} EmailPreview
 * @typedef {{ id: string, title: string, reached: boolean, conditions: ConditionResult[], fired: boolean, notifiedAt?: string, email?: EmailPreview, slot?: { start: string, end: string }, wouldFire?: boolean, error?: string }} GoalResult
 */

/**
 * The weekly check. Records progress and fires newly reached goals, unless
 * `dryRun`: then nothing is written or sent, and the result says what would
 * be. Returns { week, goals: [{ id, reached, conditions, fired, email?, error? }] }.
 * @param {{ db: any, email: null | { send(m: { to: string, subject: string, text: string, attachments?: unknown[] }): Promise<void> }, to: string | null, siteUrl?: string, kitApiKey?: string | null, kitApi?: string, fetch?: typeof fetch, log?: (line: string) => void }} ctx
 * @param {{ now: Date, dryRun?: boolean, goals?: typeof GOALS }} options
 */
export async function checkGoals(ctx, { now, dryRun = false, goals = GOALS }) {
  const log = ctx.log ?? (() => {});
  if (!dryRun) await ensureGoalsSchema(ctx.db);
  const measured = await measureGoals(ctx, { now, goals });
  const result = { week: measured[0]?.week ?? finishedWeek(now).week, dryRun, goals: /** @type {GoalResult[]} */ ([]) };
  for (const m of measured) {
    const metrics = Object.fromEntries(m.conditions.map((c) => [c.metric, c.values[0]]));
    /** @type {GoalResult} */
    const entry = { id: m.goal.id, title: m.goal.title, reached: m.reached, conditions: m.conditions.map(({ metric, label, atLeast, weeks, values, met }) => ({ metric, label, atLeast, weeks: weeks ?? 1, values, met })), fired: false };
    let event = null;
    try {
      event = (await ctx.db.execute({ sql: "SELECT * FROM goal_events WHERE goal_id = ?", args: [m.goal.id] })).rows[0] ?? null;
    } catch (e) {
      if (!/no such table/i.test(String(e?.message ?? e))) throw e;
    }
    if (!dryRun) {
      await ctx.db.execute({
        sql: `INSERT INTO goal_progress (goal_id, week, checked_at, metrics, reached) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(goal_id, week) DO UPDATE SET checked_at = excluded.checked_at, metrics = excluded.metrics, reached = excluded.reached`,
        args: [m.goal.id, m.week, iso(now), JSON.stringify(metrics), m.reached ? 1 : 0],
      });
    }
    // Fires once: when first reached, or again only if that email never went out.
    const due = event ? !event.notified_at : m.reached;
    if (!due) {
      if (event?.notified_at) entry.notifiedAt = String(event.notified_at);
      result.goals.push(entry);
      continue;
    }
    const slot = decisionSlot(now, { minutes: m.goal.meeting.minutes });
    // A retry reports the conditions that held when it was reached.
    const shown = event ? { ...m, week: String(event.reached_week), conditions: JSON.parse(String(event.met)) } : m;
    const email = goalEmail(shown, { now, slot, siteUrl: ctx.siteUrl });
    entry.email = { to: ctx.to, subject: email.subject, text: email.text, attachments: email.attachments.map((a) => ({ filename: a.filename, type: a.type, content: a.content })) };
    entry.slot = { start: iso(slot.start), end: iso(slot.end) };
    if (dryRun) {
      entry.wouldFire = true;
      result.goals.push(entry);
      continue;
    }
    if (!event) {
      await ctx.db.execute({
        sql: "INSERT INTO goal_events (goal_id, reached_at, reached_week, met, slot_start) VALUES (?, ?, ?, ?, ?) ON CONFLICT(goal_id) DO NOTHING",
        args: [m.goal.id, iso(now), m.week, JSON.stringify(m.conditions), iso(slot.start)],
      });
    }
    if (!ctx.email || !ctx.to) {
      entry.error = "owner alerts are off (no OWNER_EMAIL or email sender); tried again next week";
      await ctx.db.execute({ sql: "UPDATE goal_events SET last_error = ? WHERE goal_id = ?", args: [entry.error, m.goal.id] });
      log(`goals: ${m.goal.id} reached, not emailed (${entry.error})`);
      result.goals.push(entry);
      continue;
    }
    try {
      await ctx.email.send({ to: ctx.to, subject: email.subject, text: email.text, attachments: email.attachments });
      await ctx.db.execute({ sql: "UPDATE goal_events SET notified_at = ?, slot_start = ?, last_error = NULL WHERE goal_id = ?", args: [iso(now), iso(slot.start), m.goal.id] });
      entry.fired = true;
      log(`goals: ${m.goal.id} reached and emailed`);
    } catch (e) {
      entry.error = String(e?.message ?? e).slice(0, 200);
      await ctx.db.execute({ sql: "UPDATE goal_events SET last_error = ? WHERE goal_id = ?", args: [entry.error, m.goal.id] });
      log(`goals: ${m.goal.id} reached, email failed (${entry.error}); tried again next week`);
    }
    result.goals.push(entry);
  }
  return result;
}

/** Every goal with its recorded weeks and event, for the admin feed. */
export async function goalsHistory(db, { goals = GOALS, weeks = 12 } = {}) {
  const rows = async (sql, args) => {
    try {
      return (await db.execute({ sql, args })).rows;
    } catch (e) {
      if (/no such table/i.test(String(e?.message ?? e))) return [];
      throw e;
    }
  };
  const out = [];
  for (const g of goals) {
    const progress = await rows("SELECT week, checked_at, metrics, reached FROM goal_progress WHERE goal_id = ? ORDER BY week DESC LIMIT ?", [g.id, weeks]);
    const event = (await rows("SELECT reached_at, reached_week, met, slot_start, notified_at, last_error FROM goal_events WHERE goal_id = ?", [g.id]))[0] ?? null;
    out.push({
      id: g.id,
      history: progress.map((r) => ({ week: String(r.week), checkedAt: String(r.checked_at), metrics: JSON.parse(String(r.metrics)), reached: Boolean(Number(r.reached)) })),
      event: event && {
        reachedAt: String(event.reached_at),
        week: String(event.reached_week),
        met: JSON.parse(String(event.met)).filter((c) => c.met).map((c) => c.label),
        slotStart: event.slot_start == null ? null : String(event.slot_start),
        notifiedAt: event.notified_at == null ? null : String(event.notified_at),
        lastError: event.last_error == null ? null : String(event.last_error),
      },
    });
  }
  return out;
}
