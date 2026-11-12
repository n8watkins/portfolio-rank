import type { Metadata } from "next";
import { CalendarDays, History, Vote } from "lucide-react";
import { PollCard } from "@/components/home/PollCard";
import { DateLeaf, NextPollCard } from "@/components/polls/NextPollCard";
import { PastResults } from "@/components/polls/PastResults";
import { eyebrow } from "@/components/ui/styles";
import { db, ensureSchema } from "@/lib/db";
import { nextPollOpens, opensOn, weekRange } from "@/lib/polls/format";
import { publicPolls, type StoredPoll, type UpcomingPoll } from "@/lib/polls/server";
import { readPolls } from "@/lib/polls/store.mjs";

// The polls page: this week's poll (vote inline), what is coming, and every
// past result. Rendered at most every 5 minutes (ISR) and the same for
// everyone, so the edge cache can keep it (worker/edge-cache.ts); a
// visitor's own votes come from the browser (PollCard, PastResults).
export const revalidate = 300;

const TITLE = "Polls - PortfolioRank";
const DESCRIPTION = "One question a week about developer portfolios. Vote once, no sign-in, and see how everyone else answered.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/polls" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/polls" },
};

/** Past results the page lists. */
const PAST = 24;

export default async function PollsPage() {
  await ensureSchema();
  const now = new Date();
  const read = (await readPolls(db(), { now, past: PAST })) as { active: StoredPoll | null; upcoming: UpcomingPoll[]; past: StoredPoll[] };
  const all = await publicPolls(read.active ? [read.active, ...read.past] : read.past);
  const active = read.active ? all[0] : null;
  const past = read.active ? all.slice(1) : all;
  const upcoming = read.upcoming;
  const next = upcoming[0] ?? null;
  // Between polls "This week" already shows the next one: the list starts after it.
  const later = active ? upcoming : upcoming.slice(1);

  return (
    <div className="wrap pb-20">
      <header className="rise py-8 sm:py-12">
        <p className={eyebrow}>Community</p>
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-balance sm:text-4xl">Polls</h1>
        <p className="mt-3 max-w-2xl text-[15px] text-mute text-pretty sm:text-base">{DESCRIPTION} A new poll opens every Monday and runs for the week (Pacific time).</p>
      </header>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="this-week" className="rise">
          <h2 id="this-week" className="mb-3 flex items-center gap-2 text-lg font-bold tracking-tight">
            <Vote className="h-4 w-4 text-accent" aria-hidden /> This week
          </h2>
          {active ? (
            <PollCard poll={active} />
          ) : (
            <NextPollCard question={next?.question ?? null} opensAt={next?.opensAt ?? nextPollOpens(now)} link={false} />
          )}
        </section>

        <section aria-labelledby="upcoming" className="rise">
          <h2 id="upcoming" className="mb-3 flex items-center gap-2 text-lg font-bold tracking-tight">
            <CalendarDays className="h-4 w-4 text-accent" aria-hidden /> Coming up
          </h2>
          <div className="card p-2">
            {later.length ? (
              <ol>
                {later.map((u) => (
                  <li key={u.id} className="flex items-center gap-3.5 rounded-xl px-3 py-3">
                    <DateLeaf iso={u.opensAt} className="w-12" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-balance">{u.question}</p>
                      <p className="mt-0.5 text-xs text-mute">
                        <span className="sr-only">Opens {opensOn(u.opensAt)}, </span>
                        {weekRange(u.opensAt, u.closesAt)}
                        {u.kind === "hero" && " · two top-graded portfolios, side by side"}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-3 py-4 text-sm text-mute">The next polls are written each night. Check back on {opensOn(nextPollOpens(now))}.</p>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="past" className="reveal mt-12 sm:mt-16">
        <h2 id="past" className="mb-4 flex items-center gap-2 text-2xl font-bold tracking-tight">
          <History className="h-5 w-5 text-mute" aria-hidden /> Past results
        </h2>
        {past.length ? (
          <PastResults past={past} />
        ) : (
          <p className="card p-5 text-sm text-mute">No poll has closed yet. The first results appear here {active ? `when this week's poll closes on ${opensOn(active.closesAt)}` : "once the first poll has run"}.</p>
        )}
      </section>
    </div>
  );
}
