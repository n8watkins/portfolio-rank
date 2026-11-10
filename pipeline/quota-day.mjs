// The Gemini quota day, the one definition every "today" for Gemini budgets
// uses: Google's daily (RPD) quota resets at midnight Pacific
// (America/Los_Angeles, https://aistudio.google.com/docs/rate-limits), so a
// quota day runs midnight to midnight there, 23 or 25 hours long on the two
// DST days. Every stored time stays a real instant (UTC ISO in the
// database); only day boundaries and schedules are Pacific.
//
// Dependency-free on purpose: the pipeline, the ranking store, the Worker
// and the app all import it.

export const QUOTA_TZ = "America/Los_Angeles";

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

export const pad = (n) => String(n).padStart(2, "0");

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
