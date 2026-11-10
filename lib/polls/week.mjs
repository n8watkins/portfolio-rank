// Poll weeks: one poll a week, Monday 00:00 to the next Monday 00:00 in Los
// Angeles (the site's quota day is Pacific too, pipeline/budget.mjs). A poll's
// id is the Monday's date, "YYYY-MM-DD". Self-contained so the app's routes
// don't pull in the Gemini pipeline.
const TZ = "America/Los_Angeles";
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");

function parts(at) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: WEEKDAYS.indexOf(p.weekday) };
}

// Midnight Pacific starting a calendar day: 07:00 UTC under daylight time,
// 08:00 UTC under standard time (DST changes at 2 am, never at midnight).
function midnight(year, month, day) {
  for (const offset of [7, 8]) {
    const t = new Date(Date.UTC(year, month - 1, day, offset));
    const p = parts(t);
    if (p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0) return t;
  }
  throw new Error(`no Pacific midnight on ${year}-${month}-${day}`);
}

/** The poll week an instant falls in: { id: "YYYY-MM-DD" (its Monday), opensAt, closesAt } (Dates). */
export function pollWeek(at = new Date()) {
  const p = parts(at);
  const back = (p.weekday + 6) % 7;
  const mon = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day - back + 7));
  return {
    id: `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`,
    opensAt: midnight(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate()),
    closesAt: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/** The week after `week` (as returned by pollWeek). */
export const nextWeek = (week) => pollWeek(new Date(week.closesAt.getTime() + 3600000));
