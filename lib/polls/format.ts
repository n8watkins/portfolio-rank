// Poll dates as people read them. A poll week runs Monday 00:00 to the next
// Monday 00:00 in Los Angeles (lib/polls/week.mjs), so every date here is
// shown in that time zone: the Monday it opens and the Sunday that is its
// last day. Safe in the browser and on the server.
import { nextWeek, pollWeek } from "@/lib/polls/week.mjs";

const TZ = "America/Los_Angeles";
// closesAt is the first moment a poll is closed: the instant before is its last day.
const lastDay = (closesAt: string) => new Date(Date.parse(closesAt) - 1);

/** "1 vote", "1,204 votes". */
export const voteCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "vote" : "votes"}`;

/** "Monday, Nov 16": the day a poll opens. */
export const opensOn = (opensAt: string) => new Date(opensAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: TZ });

/** "Sunday": the last day of an open poll. */
export const closesOn = (closesAt: string) => lastDay(closesAt).toLocaleDateString("en-US", { weekday: "long", timeZone: TZ });

/** "Nov 9 to 15", or "Oct 26 to Nov 1" across a month: a poll's week. */
export function weekRange(opensAt: string, closesAt: string): string {
  const day = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: TZ });
  const from = new Date(opensAt);
  const to = lastDay(closesAt);
  const sameMonth = day(from, { month: "short" }) === day(to, { month: "short" });
  return `${day(from, { month: "short", day: "numeric" })} to ${day(to, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
}

/** When the next poll opens when none is scheduled yet: the next poll week's Monday. */
export const nextPollOpens = (now = new Date()) => nextWeek(pollWeek(now)).opensAt.toISOString();
