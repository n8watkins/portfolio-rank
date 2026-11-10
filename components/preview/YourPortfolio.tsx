import { ArrowRight, Bot, CircleCheck, Clock, LoaderCircle, Merge, RefreshCw, Swords, Trophy, Users } from "lucide-react";
import { Shot } from "@/components/preview/Shot";
import { Movement, SampleTag, TierBadge, btnPrimary, btnSecondary, card } from "@/components/preview/bits";
import { rankLabel } from "@/components/preview/RankRow";
import { leaderboard, report, sampleVisitorSite, faceoffPairs } from "@/lib/preview/data";
import type { Visitor } from "@/lib/preview/visitor";

/** The top of home for anyone who has graded before (or is waiting on it). */
export function YourPortfolio({ v }: { v: Visitor }) {
  const site = sampleVisitorSite();
  const rep = report(site);
  if (v.queued) return <Queued />;

  const head = (
    <div className="flex items-start gap-4">
      <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} eager className="hidden aspect-[16/10] w-40 shrink-0 rounded-lg border border-edge sm:block" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          Your portfolio <SampleTag what="Sample visitor" />
        </p>
        <p className="mt-1 truncate text-lg font-bold">{site.domain}</p>
        <p className="mt-0.5 text-sm text-mute">Graded {rep.gradedOn}</p>
      </div>
      <TierBadge tier={rep.grade.tier} size="lg" />
    </div>
  );

  if (!v.listed) {
    return (
      <section aria-labelledby="yours" className={`${card} p-5 sm:p-6`}>
        <h1 id="yours" className="sr-only">
          Your portfolio
        </h1>
        {head}
        <p className="mt-4 text-[15px]">
          Tier {rep.grade.tier}, about <strong>top {rep.est.topPct}%</strong>. It would rank around{" "}
          <strong className="tabular-nums">#{rep.est.rank.toLocaleString()}</strong> of {rep.est.total.toLocaleString()}.
        </p>
        {v.signedIn ? (
          <div className="mt-4 rounded-xl border border-accent/40 bg-accent-soft p-4">
            <p className="text-sm font-semibold">You're not on the leaderboard yet.</p>
            <p className="mt-1 text-sm text-mute">Join and people start voting on it in face-offs. You can leave any time.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={`/grade/${site.slug}#join`} className={btnPrimary}>
                <Trophy className="h-4 w-4" aria-hidden /> Add me to the leaderboard
              </a>
              <a href={`/grade/${site.slug}`} className={btnSecondary}>
                See report
              </a>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href={`/grade/${site.slug}`} className={btnPrimary}>
                See report <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <a href={`/grade?url=${encodeURIComponent(site.url)}`} className={btnSecondary}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Re-grade
              </a>
            </div>
            <p className="mt-3 text-xs text-mute">Saved in this browser. Sign in to keep it on every device.</p>
          </>
        )}
      </section>
    );
  }

  // Signed in and listed: rank in each view, the week, face-offs, what to fix.
  const views = [
    { key: "merged", label: "Merged", Icon: Merge },
    { key: "ai", label: "AI", Icon: Bot },
    { key: "people", label: "People", Icon: Users },
  ] as const;
  const ranks = views.map((w) => ({ ...w, r: leaderboard(w.key).find((x) => x.url === site.url)! }));
  const pairs = faceoffPairs(3);
  const results = [
    { won: true, other: pairs[0][0], when: "2 h ago" },
    { won: false, other: pairs[1][1], when: "Yesterday" },
    { won: true, other: pairs[2][0], when: "Yesterday" },
  ];
  return (
    <section aria-labelledby="yours" className={`${card} p-5 sm:p-6`}>
      <h1 id="yours" className="sr-only">
        Your portfolio
      </h1>
      {head}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {ranks.map(({ key, label, Icon, r }) => (
          <a key={key} href={`/top?view=${key}`} className="rounded-xl border border-edge bg-bg/40 px-3 py-2.5 transition hover:border-mute">
            <span className="flex items-center gap-1.5 text-xs text-mute">
              <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
            </span>
            <span className="mt-1 flex items-baseline justify-between gap-1">
              <span className="text-xl font-bold tabular-nums">#{rankLabel(r).replace("=", "")}</span>
              {key !== "ai" && <Movement move={r.move} />}
            </span>
          </a>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Swords className="h-4 w-4 text-mute" aria-hidden /> Recent face-offs <SampleTag />
          </p>
          <ul className="mt-2 grid grid-cols-1 gap-1.5 text-sm">
            {results.map((x, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={`w-10 shrink-0 text-xs font-bold ${x.won ? "text-up" : "text-down"}`}>{x.won ? "Won" : "Lost"}</span>
                <span className="min-w-0 flex-1 truncate">vs {x.other.domain}</span>
                <span className="shrink-0 text-xs text-mute">{x.when}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold">What to improve</p>
          <ol className="mt-2 grid grid-cols-1 gap-1.5 text-sm">
            {rep.improvements.slice(0, 2).map((m, i) => (
              <li key={m.title} className="flex gap-2">
                <span className="text-mute tabular-nums">{i + 1}.</span>
                <a href={`/how#${m.criterion}`} className="hover:text-accent">
                  {m.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-edge pt-4">
        <a href={`/grade/${site.slug}`} className={btnPrimary}>
          See full report <ArrowRight className="h-4 w-4" aria-hidden />
        </a>
        <a href={`/grade?url=${encodeURIComponent(site.url)}`} className={btnSecondary}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Re-grade
        </a>
      </div>
    </section>
  );
}

const STEPS = [
  { label: "Screenshot taken", done: true },
  { label: "Measured checks done", done: true },
  { label: "AI judgment", done: false },
];

export function Queued({ standalone = false }: { standalone?: boolean }) {
  const site = sampleVisitorSite();
  const H = standalone ? "h1" : "h2";
  return (
    <section aria-labelledby="queued" className={`${card} p-5 sm:p-6`}>
      {!standalone && (
        <h1 className="sr-only">Your report</h1>
      )}
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
        Your report <SampleTag what="Sample visitor" />
      </p>
      <H id="queued" className="mt-1 text-xl font-bold tracking-tight">
        Your report on {site.domain} is being prepared
      </H>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={2} aria-label="Report progress">
        <div className="h-full w-2/3 rounded-full bg-accent" />
      </div>
      <ol className="mt-4 grid grid-cols-1 gap-2 text-sm">
        {STEPS.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            {s.done ? (
              <CircleCheck className="h-4 w-4 text-up" aria-hidden />
            ) : (
              <LoaderCircle className="h-4 w-4 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
            )}
            <span className={s.done ? "" : "font-semibold"}>{s.label}</span>
            <span className="sr-only">{s.done ? "done" : "waiting"}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-raised p-3.5 text-sm">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
        <p>
          Today's AI grading is used up, so yours is first in line tomorrow morning.{" "}
          <strong>We'll email you@example.com</strong> when it's ready. You can close this page.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href="/rank" className={btnSecondary}>
          <Swords className="h-4 w-4" aria-hidden /> Vote in a face-off meanwhile
        </a>
      </div>
    </section>
  );
}
