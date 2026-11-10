import { AppShell } from "@/components/shell/AppShell";
import { PastPoll } from "@/components/preview/PastPolls";
import { PollCard } from "@/components/preview/PollCard";
import { SampleTag } from "@/components/preview/bits";
import { polls, totalVotes } from "@/lib/preview/polls";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Polls - PortfolioRank" };

export default async function PollsPage({ searchParams }: { searchParams: Promise<{ state?: string; voted?: string }> }) {
  const sp = await searchParams;
  const v = await visitor(sp);
  const { active, past } = polls();
  const all = [active, ...past];
  const votes = all.reduce((n, p) => n + totalVotes(p), 0);
  const heroPolls = past.filter((p) => p.kind === "hero");
  const leftWins = heroPolls.filter((p) => p.options[0].votes > p.options[1].votes).length;

  return (
    <AppShell visitor={v} current="other">
      <div className="py-8 sm:py-10">
        <div className="rise">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight">
            Polls <SampleTag what="Polls and counts" />
          </h1>
          <p className="mt-1.5 text-sm text-mute">One question a week about what makes a portfolio work. Vote without an account; results show right after.</p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <div className="rise" style={{ "--d": "60ms" } as React.CSSProperties}>
            <PollCard poll={active} showAll={false} forceVoted={sp.voted ? 0 : undefined} />
          </div>
          <section aria-labelledby="poll-stats" className="card rise flex flex-col p-5" style={{ "--d": "120ms" } as React.CSSProperties}>
            <h2 id="poll-stats" className="text-lg font-bold tracking-tight">
              So far
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              {[
                { label: "Polls run", value: all.length },
                { label: "Votes cast", value: votes.toLocaleString() },
                { label: "Hero polls", value: heroPolls.length + 1 },
                { label: "Closest result", value: "50.4%" },
              ].map((i) => (
                <div key={i.label} className="rounded-xl border border-edge bg-bg/40 px-3 py-2.5">
                  <dt className="text-xs text-mute">{i.label}</dt>
                  <dd className="mt-0.5 text-xl font-bold tabular-nums">{i.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-auto pt-4 text-sm">
              <p className="font-semibold">What we&apos;ve learned</p>
              <ul className="mt-1.5 grid gap-1.5 text-mute">
                <li>The hero on the left won {leftWins} of {heroPolls.length} hero polls, so being shown first is no advantage.</li>
                <li>Most voters want your photo on the first screen.</li>
                <li>Dark beats light, 61% to 39%.</li>
              </ul>
            </div>
          </section>
        </div>

        <h2 className="mt-12 text-lg font-bold tracking-tight">Past polls</h2>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {past.map((p) => (
            <PastPoll key={p.id} poll={p} className="reveal" />
          ))}
          <div className="card reveal flex flex-col justify-center p-5 text-sm">
            <p className="font-semibold">Got a question for next week?</p>
            <p className="mt-1 text-mute">Polls come from what people ask about their portfolios. Suggest one on GitHub.</p>
            <a href="https://github.com/n8watkins/portfolio-rank/issues/new" className="mt-3 font-semibold text-accent hover:underline">
              Suggest a poll
            </a>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
