import { Activity, ArrowRight, BookOpen, Split, Swords, TrendingUp } from "lucide-react";
import { Shot } from "@/components/preview/Shot";
import { LiveStatsClient } from "@/components/preview/LiveStatsClient";
import { Movement, SampleTag, sectionTitle } from "@/components/preview/bits";
import { climbers, disagreements, faceoffPairs, stats } from "@/lib/preview/data";

export function Climbers({ className = "" }: { className?: string }) {
  return (
    <section aria-labelledby="climbers" className={`card p-4 sm:p-5 ${className}`}>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 id="climbers" className={`${sectionTitle} flex items-center gap-2`}>
          <TrendingUp className="h-4 w-4 text-mute" aria-hidden /> This week&apos;s climbers
        </h2>
        <SampleTag />
      </div>
      <ol className="flex flex-1 flex-col justify-between">
        {climbers(7).map((r) => (
          <li key={r.url}>
            <a href={`/grade/${r.slug}`} className="group flex items-center gap-3 rounded-xl px-1 py-2.5 transition hover:bg-raised">
              <Shot base={r.shot} alt="" domain={r.domain} className="aspect-square w-10 shrink-0 rounded-lg border border-edge" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{r.name}</span>
                <span className="block text-xs text-mute tabular-nums">Now #{r.rank} merged</span>
              </span>
              <Movement move={r.move} className="nudge-up" />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Live stats: portfolios and graded are real counts, the rest sample. */
export function LiveStats({ className = "" }: { className?: string }) {
  const s = stats();
  const items = [
    { key: "portfolios", label: "Portfolios", value: s.portfolios, sample: false },
    { key: "graded", label: "Graded by AI", value: s.graded, sample: false },
    { key: "grades", label: "Grades this week", value: s.gradesThisWeek, sample: true },
    { key: "votes", label: "Votes today", value: s.votesToday, sample: true },
  ];
  return (
    <section aria-labelledby="stats" className={`card p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 id="stats" className={`${sectionTitle} flex items-center gap-2`}>
          <Activity className="h-4 w-4 text-mute" aria-hidden /> Live
        </h2>
        <span className="flex items-center gap-2 text-xs text-mute">
          <span className="attn-dot" aria-hidden /> updating
        </span>
      </div>
      <LiveStatsClient initial={items} />
      <div className="mt-3 flex items-center justify-between gap-2 px-1 text-xs text-mute">
        <span>* sample numbers</span>
        <a href="/how" className="group inline-flex items-center gap-1 font-semibold text-ink hover:text-accent">
          <BookOpen className="h-3.5 w-3.5" aria-hidden /> How grading works
          <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </section>
  );
}

/** Where Gemini and voters disagree most. */
export function Disagreements({ className = "" }: { className?: string }) {
  const list = disagreements(3);
  return (
    <section aria-labelledby="split" className={`card flex flex-col p-4 sm:p-5 ${className}`}>
      <div className="mb-1 flex items-center justify-between px-1">
        <h2 id="split" className={`${sectionTitle} flex items-center gap-2`}>
          <Split className="h-4 w-4 text-mute" aria-hidden /> AI vs people
        </h2>
        <SampleTag />
      </div>
      <p className="mb-2 px-1 text-sm text-mute">The biggest disagreements this week.</p>
      <ol className="flex-1">
        {list.map((r) => (
          <li key={r.url}>
            <a href={`/grade/${r.slug}`} className="flex items-center gap-3 rounded-xl px-1 py-2 transition hover:bg-raised">
              <Shot base={r.shot} alt="" domain={r.domain} className="aspect-square w-9 shrink-0 rounded-lg border border-edge" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{r.name}</span>
                <span className="block text-xs text-mute tabular-nums">
                  AI ranks #{r.aiRank}, people #{r.peopleRank}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>
      <a href="/top?view=ai" className="group mt-2 inline-flex items-center gap-1 px-1 text-sm font-semibold text-accent">
        Compare the views <ArrowRight className="nudge h-4 w-4" aria-hidden />
      </a>
    </section>
  );
}

/** A face-off invitation that shows a real pair. */
export function FaceOffTeaser({ className = "" }: { className?: string }) {
  const [a, b] = faceoffPairs(1)[0];
  return (
    <a href="/rank" className={`card card-hover group flex flex-col p-4 sm:p-5 ${className}`}>
      <span className="flex items-center gap-3">
        <span className="icon-tile h-10 w-10 shrink-0">
          <Swords className="icon-shake h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Vote in a face-off</span>
          <span className="block text-sm text-mute">Two portfolios. Pick the one you&apos;d hire from.</span>
        </span>
        <ArrowRight className="nudge h-4 w-4 text-mute" aria-hidden />
      </span>
      <span className="mt-4 grid min-h-24 flex-1 grid-cols-2 gap-2">
        {[a, b].map((e) => (
          <Shot key={e.url} base={e.shot} alt="" domain={e.domain} className="h-full min-h-24 w-full rounded-lg border border-edge" />
        ))}
      </span>
      <span className="mt-2 flex justify-between gap-2 text-xs text-mute">
        <span className="truncate">{a.domain}</span>
        <span className="truncate text-right">{b.domain}</span>
      </span>
    </a>
  );
}
