import { ArrowRight, History } from "lucide-react";
import { PollBar } from "@/components/preview/PollResult";
import { SampleTag, sectionTitle } from "@/components/preview/bits";
import { pct, totalVotes, type Poll } from "@/lib/preview/polls";

function verdict(poll: Poll): string {
  const sorted = [...poll.options].sort((a, b) => b.votes - a.votes);
  const margin = pct(poll, sorted[0]) - pct(poll, sorted[1]);
  const name = sorted[0].site ? `${sorted[0].label} (${sorted[0].site.domain})` : sorted[0].label;
  return margin <= 1 ? `Too close to call: ${name} by ${sorted[0].votes - sorted[1].votes} votes.` : `${name} won by ${margin} points.`;
}

/** One finished poll with labelled results. */
export function PastPoll({ poll, className = "" }: { poll: Poll; className?: string }) {
  const max = Math.max(...poll.options.map((o) => o.votes));
  return (
    <article className={`card flex flex-col p-5 ${className}`}>
      <p className="text-xs text-mute">
        {poll.opened} to {poll.closed} · {totalVotes(poll).toLocaleString()} votes
      </p>
      <h3 className="mt-1 font-bold tracking-tight">{poll.question}</h3>
      {poll.kind === "hero" && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {poll.options.map((o) => (
            <a key={o.label} href={`/grade/${o.site!.slug}`} className="group block overflow-hidden rounded-lg border border-edge">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${o.site!.shot}/hero.jpg`} alt={`${o.label}: ${o.site!.domain}`} loading="lazy" className="aspect-[16/9] w-full bg-raised object-cover object-top transition group-hover:scale-[1.02]" />
            </a>
          ))}
        </div>
      )}
      <div className="mb-4 mt-4 grid gap-3">
        {poll.options.map((o) => (
          <PollBar key={o.label} label={o.site ? `${o.label}: ${o.site.domain}` : o.label} votes={o.votes} pct={pct(poll, o)} lead={o.votes === max} />
        ))}
      </div>
      <p className="mt-auto border-t border-edge pt-3 text-xs text-mute">{verdict(poll)}</p>
    </article>
  );
}

/** Home: the last few results, compact. */
export function PastPollsMini({ past }: { past: Poll[] }) {
  return (
    <section aria-labelledby="past-polls" className="card flex h-full flex-col p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="past-polls" className={`${sectionTitle} flex items-center gap-2`}>
          <History className="h-4 w-4 text-mute" aria-hidden /> Past polls
        </h2>
        <SampleTag />
      </div>
      <ul className="mt-3 flex flex-1 flex-col justify-between gap-4">
        {past.slice(0, 3).map((p) => {
          const win = p.options.reduce((a, b) => (b.votes > a.votes ? b : a));
          return (
            <li key={p.id}>
              <p className="text-xs text-mute">
                {p.closed} · {totalVotes(p).toLocaleString()} votes
              </p>
              <p className="mt-0.5 text-sm font-semibold">{p.question}</p>
              <div className="mt-2">
                <PollBar label={win.site ? `${win.label}: ${win.site.domain}` : win.label} votes={win.votes} pct={pct(p, win)} lead />
              </div>
            </li>
          );
        })}
      </ul>
      <a href="/polls" className="group mt-4 inline-flex items-center gap-1 text-sm font-semibold text-accent">
        All polls and results <ArrowRight className="nudge h-4 w-4" aria-hidden />
      </a>
    </section>
  );
}
