import { ArrowRight, Bot, ExternalLink, Merge, Sparkles, Swords, TrendingUp, Users } from "lucide-react";
import { AppShell } from "@/components/shell/AppShell";
import { GradeForm } from "@/components/preview/GradeForm";
import { RankChart } from "@/components/preview/RankChart";
import { rankLabel } from "@/components/preview/RankRow";
import { Regrade } from "@/components/preview/Regrade";
import { Badges } from "@/components/preview/Badges";
import { Shot } from "@/components/preview/Shot";
import { Queued } from "@/components/preview/YourPortfolio";
import { Movement, SampleTag, TierBadge, btnSecondary, sectionTitle } from "@/components/preview/bits";
import { faceoffPairs, leaderboard, profile, recommendations, report, sampleVisitorSite } from "@/lib/preview/data";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your portfolio - PortfolioRank" };

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

export default async function MePage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);

  if (v.state === "first") {
    return (
      <AppShell visitor={v} current="grade">
        <section className="mx-auto max-w-xl py-16 text-center">
          <span className="icon-tile mx-auto h-12 w-12">
            <Sparkles className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="mt-5 text-2xl font-bold tracking-tight">Your portfolio lives here once it&apos;s graded</h1>
          <p className="mt-2 text-mute">Grade it to see your rank, how you compare in every criterion, and what to fix first.</p>
          <div className="mt-6 text-left">
            <GradeForm id="me-grade" />
          </div>
        </section>
      </AppShell>
    );
  }

  if (v.queued) {
    return (
      <AppShell visitor={v} current="grade">
        <div className="mx-auto flex max-w-2xl py-10 sm:py-14">
          <Queued standalone />
        </div>
      </AppShell>
    );
  }

  const site = sampleVisitorSite();
  const rep = report(site);
  const prof = profile(site);
  const recs = recommendations(site);
  const views = [
    { key: "merged", label: "Merged", Icon: Merge },
    { key: "ai", label: "AI", Icon: Bot },
    { key: "people", label: "People", Icon: Users },
  ] as const;
  const ranks = views.map((w) => ({ ...w, r: leaderboard(w.key).find((x) => x.url === site.url)! }));
  const pairs = faceoffPairs(6);
  const fights = [
    { won: true, other: pairs[0][0], when: "2 h ago", pct: 58 },
    { won: false, other: pairs[1][1], when: "Yesterday", pct: 41 },
    { won: true, other: pairs[2][0], when: "Yesterday", pct: 66 },
    { won: true, other: pairs[3][1], when: "Nov 7", pct: 52 },
    { won: false, other: pairs[4][0], when: "Nov 6", pct: 37 },
  ];
  const wins = fights.filter((f) => f.won).length;

  return (
    <AppShell visitor={v} current="grade">
      <div className="py-8 sm:py-10">
        <p className="rise flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          Your portfolio <SampleTag what="Sample visitor and history" />
        </p>

        {/* Who, the grade, and re-grade */}
        <section aria-labelledby="me" className="card rise mt-3 grid grid-cols-1 gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)]" style={d(60)}>
          <Shot base={site.shot} alt={`Screenshot of ${site.domain}`} domain={site.domain} eager className="aspect-[16/10] w-full rounded-xl border border-edge" />
          <div className="flex min-w-0 flex-col">
            <h1 id="me" className="truncate text-2xl font-bold tracking-tight">
              {site.domain}
            </h1>
            <a href={site.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-sm text-mute hover:text-ink">
              {site.name} · {prof.role} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            <div className="mt-5 flex items-center gap-4">
              <TierBadge tier={rep.grade.tier} size="lg" />
              <div>
                <p className="text-lg font-bold">Tier {rep.grade.tier}, about top {rep.est.topPct}%</p>
                <p className="text-sm text-mute">
                  Would rank around #{rep.est.rank} of {rep.est.total.toLocaleString()} on the AI grade alone.
                </p>
              </div>
            </div>
            <div className="mt-auto flex flex-wrap gap-2 pt-5">
              <a href={`/grade/${site.slug}`} className={btnSecondary}>
                Full report <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </a>
              {!v.listed && (
                <a href={`/grade/${site.slug}#join`} className={btnSecondary}>
                  Add me to the leaderboard
                </a>
              )}
              <a href={`/claim/${site.slug}?step=${v.signedIn ? "verified" : "signin"}`} className={btnSecondary}>
                {v.signedIn ? "Owner settings" : "Claim it"}
              </a>
            </div>
          </div>
          <Regrade gradedOn={rep.gradedOn} />
        </section>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5">
            <section aria-labelledby="ranks" className="card reveal p-5">
              <h2 id="ranks" className={sectionTitle}>
                {v.listed ? "Your rank" : "Where you would rank"}
              </h2>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {ranks.map(({ key, label, Icon, r }) => (
                  <a key={key} href={`/top?view=${key}`} className="card-hover group rounded-xl border border-edge bg-bg/40 px-3 py-3">
                    <span className="flex items-center gap-1.5 text-xs text-mute">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                    </span>
                    <span className="mt-1 flex items-baseline justify-between gap-1">
                      <span className="text-xl font-bold tabular-nums sm:text-2xl">#{rankLabel(r).replace("=", "")}</span>
                      {key !== "ai" && <Movement move={r.move} className="nudge-up" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-mute tabular-nums">
                      {key === "ai" ? `Top ${r.topPct}%` : r.likely[0] === r.likely[1] ? "Settled" : `Likely #${r.likely[0]}-#${r.likely[1]}`}
                    </span>
                  </a>
                ))}
              </div>
            </section>

            <section aria-labelledby="history" className="card reveal flex flex-1 flex-col p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 id="history" className={`${sectionTitle} flex items-center gap-2`}>
                  <TrendingUp className="h-4 w-4 text-mute" aria-hidden /> Merged rank, last 8 weeks
                </h2>
                <SampleTag />
              </div>
              <p className="mt-1 text-sm text-mute">
                Up {prof.history[0].rank - prof.history[prof.history.length - 1].rank} places since {prof.history[0].week}. Higher on the chart is better.
              </p>
              <div className="flex flex-1 items-center pt-3">
                <RankChart points={prof.history} />
              </div>
            </section>

          </div>
            <section aria-labelledby="recs" className="card reveal p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 id="recs" className={`${sectionTitle} flex items-center gap-2`}>
                  <Sparkles className="h-4 w-4 text-mute" aria-hidden /> What to improve
                </h2>
                <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute">Gemini</span>
              </div>
              <p className="mt-1 text-sm text-mute">In order: the first one moves you most.</p>
              {recs.length === 0 && (
                <p className="mt-4 rounded-xl border border-up/30 bg-up/10 p-4 text-sm">
                  <span className="block font-semibold">Nothing urgent to fix.</span>
                  <span className="block text-mute">Every check passes and every score is high. Votes in face-offs are what move you now.</span>
                </p>
              )}
              <ol className="mt-4 grid grid-cols-1 gap-3">
                {recs.map((m, i) => (
                  <li key={m.title} className="flex gap-3 rounded-xl border border-edge bg-bg/40 p-3.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-xs font-bold text-on-fill">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="font-semibold leading-snug">{m.title}</p>
                      <p className="mt-0.5 text-sm text-mute">{m.why}</p>
                      <p className="mt-1.5 text-sm">
                        <span className="text-mute">Expected effect:</span> {m.effect} <SampleTag />
                      </p>
                      <a href={`/about#${m.criterion}`} className="group mt-1.5 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                        The criterion <ArrowRight className="nudge h-3.5 w-3.5" aria-hidden />
                      </a>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <section aria-labelledby="stand" className="card reveal flex flex-col p-5">
              <h2 id="stand" className={sectionTitle}>
                Where you stand
              </h2>
              <p className="mt-1 text-sm text-mute">
                Your AI grade in each criterion, compared with all {prof.total} graded portfolios and with {prof.peers} {prof.role.toLowerCase()} portfolios.
              </p>
              <div className="mt-3 overflow-hidden rounded-xl border border-edge">
                <table className="w-full text-sm">
                  <thead className="bg-raised text-left text-xs text-mute">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">Criterion</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Grade</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">vs all</th>
                      <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">vs {prof.role.toLowerCase()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prof.standings.map((s) => (
                      <tr key={s.label} className="border-t border-edge">
                        <th scope="row" className="px-3 py-2.5 text-left font-medium">
                          <a href={`/about#${s.criterion}`} className="hover:text-accent">
                            {s.label}
                          </a>
                        </th>
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.value}/5</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span className="font-semibold">Better than {s.vsAll}%</span>
                          <span className="block text-xs text-mute sm:hidden">{s.vsRole}% of {prof.role.toLowerCase()}</span>
                        </td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">Better than {s.vsRole}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-auto pt-4 text-xs text-mute">&quot;Better than 72%&quot; means your grade beats 72% of those portfolios; ties count as half.</p>
            </section>
            <section aria-labelledby="fights" className="card reveal flex flex-col p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 id="fights" className={`${sectionTitle} flex items-center gap-2`}>
                  <Swords className="h-4 w-4 text-mute" aria-hidden /> Latest face-offs
                </h2>
                <SampleTag />
              </div>
              {!v.listed ? (
                <div className="mt-3 flex flex-1 flex-col items-start justify-center gap-3 rounded-xl border border-dashed border-edge-strong p-5 text-sm">
                  <p>
                    <span className="block font-semibold">Not in face-offs yet</span>
                    <span className="block text-mute">Add your portfolio to the leaderboard and people start voting on it. Results show up here.</span>
                  </p>
                  <a href={`/grade/${site.slug}#join`} className="btn-sheen inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold">
                    Add me to the leaderboard
                  </a>
                </div>
              ) : (
              <>
              <p className="mt-1 text-sm text-mute">
                Won {wins} of the last {fights.length}.
              </p>
              <ul className="mt-3 flex-1">
                {fights.map((f, i) => (
                  <li key={i} className="flex items-center gap-3 border-t border-edge py-2.5 first:border-t-0">
                    <Shot base={f.other.shot} alt="" domain={f.other.domain} className="aspect-square w-9 shrink-0 rounded-lg border border-edge" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className={`font-semibold ${f.won ? "text-up" : "text-down"}`}>{f.won ? "Won" : "Lost"}</span> vs {f.other.domain}
                      </span>
                      <span className="block text-xs text-mute">
                        {f.pct}% of voters picked you · {f.when}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <a href="/rank" className="group mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent">
                Vote in a face-off <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </a>
              </>
              )}
            </section>
        </div>
        <Badges state={v.state} signedIn={v.signedIn} />
      </div>
    </AppShell>
  );
}
