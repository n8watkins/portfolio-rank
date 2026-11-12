import { ArrowRight, CalendarClock } from "lucide-react";
import { opensOn } from "@/lib/polls/format";
import type { UpcomingPoll } from "@/lib/polls/server";
import { ROUTES } from "@/lib/nav";

const TZ = "America/Los_Angeles";
const part = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString("en-US", { ...o, timeZone: TZ });

/** A small calendar leaf: the weekday, day and month a poll opens. */
export function DateLeaf({ iso, className = "" }: { iso: string; className?: string }) {
  return (
    <span aria-hidden className={`grid w-14 shrink-0 overflow-hidden rounded-xl border border-edge bg-card text-center shadow-[var(--card-hi)] ${className}`}>
      <span className="bg-fill py-0.5 text-[10px] font-bold uppercase tracking-wider text-on-fill">{part(iso, { month: "short" })}</span>
      <span className="pt-1 text-xl leading-none font-bold tabular-nums">{part(iso, { day: "numeric" })}</span>
      <span className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-mute">{part(iso, { weekday: "short" })}</span>
    </span>
  );
}

/**
 * The poll card between polls: what the next poll asks (or that one is
 * coming) and the day it opens, so the home page never loses its poll.
 */
export function NextPollCard({ question, opensAt, later = [], link = true }: { question: string | null; opensAt: string; later?: UpcomingPoll[]; link?: boolean }) {
  const href = link ? ROUTES.polls : null;
  return (
    <section aria-labelledby="next-poll" className="card flex h-full flex-col p-5 sm:p-6">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
        <CalendarClock className="h-4 w-4" aria-hidden /> Poll of the week
      </p>
      <div className="mt-3 flex items-start gap-4">
        <DateLeaf iso={opensAt} />
        <div className="min-w-0">
          <h3 id="next-poll" className="text-xl font-bold tracking-tight text-balance">
            {question ? (
              <>
                <span className="text-mute">Next poll:</span> {question}
              </>
            ) : (
              "Next poll coming soon"
            )}
          </h3>
          <p className="mt-1 text-sm text-mute">
            Opens {opensOn(opensAt)}. One vote per visitor, no sign-in.
          </p>
        </div>
      </div>
      {later.length > 0 && (
        <div className="mt-5 border-t border-edge pt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-mute">After that</p>
          <ul className="mt-2 grid gap-1.5 text-sm">
            {later.map((u) => (
              <li key={u.id} className="flex gap-3">
                <span className="w-14 shrink-0 tabular-nums text-mute">{part(u.opensAt, { month: "short", day: "numeric" })}</span>
                <span className="min-w-0 font-medium">{u.question}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {href && (
        <a href={href} className="group mt-auto inline-flex min-h-11 items-center gap-1 self-start pt-4 text-sm font-semibold text-accent">
          See past and upcoming polls <ArrowRight className="nudge h-4 w-4" aria-hidden />
        </a>
      )}
    </section>
  );
}
