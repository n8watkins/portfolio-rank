import type { Metadata } from "next";
import { ArrowRight, CircleAlert, CircleCheck, ExternalLink, Lightbulb, Sparkles, Swords, Trophy, UsersRound } from "lucide-react";
import { GradeForm } from "@/components/grade/GradeForm";
import { Badges } from "@/components/me/Badges";
import { Queued } from "@/components/me/Queued";
import { Regrade } from "@/components/me/Regrade";
import { Thumb } from "@/components/home/Thumb";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { TierBadge } from "@/components/ui/badges";
import { btnPrimary, btnSecondary, sectionTitle } from "@/components/ui/styles";
import { BADGES } from "@/lib/games/badges.mjs";
import { REGRADE_COOLDOWN_DAYS } from "@/pipeline/budget.mjs";
import { gamesEnabled } from "@/lib/games/server";
import { graderEnabled } from "@/lib/grader/server";
import { myPortfolio, type Mine } from "@/lib/me";
import { ROUTES } from "@/lib/nav";
import { SITE } from "@/lib/site";

// The visitor's own portfolio page: their latest grade, its progress while it
// runs, then where it stands and what to fix. Read through the signed owner
// cookie, so it is rendered per visit and never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your portfolio - PortfolioRank", robots: { index: false } };

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;
const ACTIVE = new Set(["capturing", "waiting", "grading", "queued", "awaiting_key"]);

function Narrow({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">{children}</div>;
}

export default async function MePage() {
  if (!graderEnabled()) {
    return (
      <Narrow>
        <EmptyState
          icon={Sparkles}
          title="Your portfolio page opens with grading"
          className="w-full"
          action={
            ROUTES.faceoff ? (
              <a href={ROUTES.faceoff} className={btnPrimary}>
                <Swords className="icon-shake h-4 w-4" aria-hidden /> Vote in a face-off
              </a>
            ) : undefined
          }
        >
          Soon you can paste your portfolio&apos;s link and see your grade, where you&apos;d rank and what to fix first, right here. Until then, your votes decide who rises.
        </EmptyState>
      </Narrow>
    );
  }

  const mine = await myPortfolio();

  if (!mine) {
    return (
      <section aria-labelledby="first" className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <span className="icon-tile mx-auto h-12 w-12">
          <Sparkles className="h-6 w-6" aria-hidden />
        </span>
        <h1 id="first" className="mt-5 text-2xl font-bold tracking-tight text-balance">
          Your portfolio lives here once it&apos;s graded
        </h1>
        <p className="mt-2 text-mute text-pretty">Grade it to see your rank, how you compare in every criterion, and what to fix first.</p>
        <div className="mt-6 text-left">
          <GradeForm />
        </div>
      </section>
    );
  }

  const { job } = mine;
  if (ACTIVE.has(job.status)) {
    return (
      <Narrow>
        <Queued job={job} />
      </Narrow>
    );
  }

  if (!job.report) {
    const message =
      job.status === "unavailable"
        ? "Grading couldn't start this time. Try again in a little while."
        : (job.reason ?? (job.checks && !job.checks.ok ? job.checks.message : null) ?? "Something went wrong while grading. Try again.");
    return (
      <Narrow>
        <section aria-labelledby="failed" className="card w-full p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-mute">Your report</p>
          <h1 id="failed" className="mt-1 text-xl font-bold tracking-tight">
            We couldn&apos;t grade {job.domain}
          </h1>
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-raised p-3.5 text-sm">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden /> {message}
          </p>
          <div className="mt-5">
            <GradeForm compact />
          </div>
        </section>
      </Narrow>
    );
  }

  return <Report mine={mine} />;
}

function Report({ mine }: { mine: Mine }) {
  const { job, listed, standings } = mine;
  const rep = job.report!;
  const pct = rep.percentile;
  const role = rep.roles[0];
  const fights = listed?.fights ?? [];
  const wins = fights.filter((f) => f.won).length;
  const learn = rep.better.flatMap((b) => b.sites.map((s) => ({ ...s, why: b.label }))).slice(0, 5);
  const close = rep.similar.slice(0, 5);

  return (
    <div className="wrap py-8 sm:py-10">
      <p className="rise text-xs font-semibold uppercase tracking-wider text-mute">Your portfolio</p>

      {/* Who, the grade, and re-grade */}
      <section
        aria-labelledby="me"
        className="card rise mt-3 grid grid-cols-1 gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)]"
        style={d(60)}
      >
        <ScreenshotFrame src={mine.hero} alt={`Screenshot of ${job.domain}`} domain={job.domain} eager className="w-full rounded-xl border border-edge" />
        <div className="flex min-w-0 flex-col">
          <h1 id="me" className="truncate text-2xl font-bold tracking-tight">
            {job.domain}
          </h1>
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex w-fit max-w-full items-center gap-1 text-sm text-mute hover:text-ink">
            <span className="truncate">
              {mine.name}
              {role ? ` · ${role[0].toUpperCase()}${role.slice(1)}` : ""}
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <div className="mt-5 flex items-center gap-4">
            <TierBadge tier={rep.tier} size="lg" />
            <div className="min-w-0">
              <p className="text-lg font-bold">
                Tier {rep.tier}
                {pct ? `, about top ${pct.topPct}%` : ""}
              </p>
              {pct && (
                <p className="text-sm text-mute">
                  Would rank around #{pct.rank.toLocaleString("en-US")} of {pct.total.toLocaleString("en-US")} on the AI grade alone.
                </p>
              )}
            </div>
          </div>
          {listed?.people && (
            <p className="mt-4 flex items-center gap-2 text-sm">
              <Trophy className="h-4 w-4 text-accent" aria-hidden />
              <span>
                <strong className="tabular-nums">#{listed.people.rank.toLocaleString("en-US")}</strong> on the people&apos;s board{" "}
                <span className="text-mute tabular-nums">
                  · ELO {listed.people.elo} · {listed.people.votes.toLocaleString("en-US")} {listed.people.votes === 1 ? "vote" : "votes"}
                </span>
              </span>
            </p>
          )}
          <div className="mt-auto flex flex-wrap gap-2 pt-5">
            {listed && (
              <a href={listed.path} className={btnSecondary}>
                Your page on the list <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </a>
            )}
            {ROUTES.top && listed?.people && (
              <a href={ROUTES.top} className={btnSecondary}>
                Leaderboard
              </a>
            )}
          </div>
        </div>
        <Regrade url={job.url} gradedAt={rep.gradedAt} regradeAfter={rep.regradeAfter} cooldownDays={REGRADE_COOLDOWN_DAYS} now={mine.at} />
      </section>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {standings && standings.rows.length > 0 ? (
          <section aria-labelledby="stand" className="card reveal flex flex-col p-5">
            <h2 id="stand" className={sectionTitle}>
              Where you stand
            </h2>
            <p className="mt-1 text-sm text-mute">
              Your AI grade in each criterion, compared with all {standings.total.toLocaleString("en-US")} graded portfolios
              {standings.role ? ` and with ${standings.peers.toLocaleString("en-US")} ${standings.role} portfolios` : ""}.
            </p>
            <div className="mt-3 overflow-hidden rounded-xl border border-edge">
              <table className="w-full text-sm">
                <thead className="bg-raised text-left text-xs text-mute">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Criterion
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Grade
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      vs all
                    </th>
                    {standings.role && (
                      <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                        vs {standings.role}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {standings.rows.map((s) => (
                    <tr key={s.id} className="border-t border-edge">
                      <th scope="row" className="px-3 py-2.5 text-left font-medium">
                        {s.label}
                      </th>
                      <td className="px-3 py-2.5 text-right tabular-nums">{s.score}/5</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className="font-semibold">Better than {s.vsAll}%</span>
                        {s.vsRole !== null && (
                          <span className="block text-xs text-mute sm:hidden">
                            {s.vsRole}% of {standings.role}
                          </span>
                        )}
                      </td>
                      {standings.role && <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">Better than {s.vsRole}%</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-auto pt-4 text-xs text-mute">&quot;Better than 72%&quot; means your grade beats 72% of those portfolios; ties count as half.</p>
          </section>
        ) : (
          <section aria-labelledby="stand" className="card reveal p-5">
            <h2 id="stand" className={sectionTitle}>
              What Gemini saw
            </h2>
            <ul className="mt-3 grid gap-2 text-sm">
              {rep.judgments.map((j) => (
                <li key={j.id} className="flex justify-between gap-3 border-t border-edge pt-2 first:border-t-0 first:pt-0">
                  <span className="font-medium">{j.label}</span>
                  <span className="tabular-nums">{typeof j.score === "number" ? `${j.score}/5` : "-"}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="recs" className="card reveal p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="recs" className={`${sectionTitle} flex items-center gap-2`}>
              <Sparkles className="h-4 w-4 text-mute" aria-hidden /> What to improve
            </h2>
            {rep.model && <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-mute">Gemini</span>}
          </div>
          {rep.fixes.length === 0 && (
            <p className="mt-4 rounded-xl border border-up/30 bg-up/10 p-4 text-sm">
              <span className="block font-semibold">Nothing urgent to fix.</span>
              <span className="block text-mute">Every check passes and every score is high. Votes in face-offs are what move you now.</span>
            </p>
          )}
          {rep.fixes.length === 0 && rep.strengths.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold">What&apos;s working</h3>
              <ul className="mt-2 grid grid-cols-1 gap-3">
                {rep.strengths.map((m) => (
                  <li key={m.criterion} className="flex gap-3 rounded-xl border border-edge bg-bg/40 p-3.5">
                    <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-up" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-semibold leading-snug">{m.title}</p>
                      <p className="mt-0.5 text-sm text-mute">{m.why}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {rep.fixes.length > 0 && (
            <>
              <p className="mt-1 text-sm text-mute">In order: the first one moves you most.</p>
              <ol className="mt-4 grid grid-cols-1 gap-3">
                {rep.fixes.map((m, i) => (
                  <li key={m.criterion} className="flex gap-3 rounded-xl border border-edge bg-bg/40 p-3.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-xs font-bold text-on-fill">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="font-semibold leading-snug">{m.title}</p>
                      <p className="mt-0.5 text-sm text-mute">{m.why}</p>
                      <p className="mt-1.5 text-xs text-mute">{m.by === "ai" ? "From Gemini's judgment" : "From a measured check"}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {ROUTES.grading && (
                <a href={ROUTES.grading} className="group mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
                  How each criterion is graded <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </a>
              )}
            </>
          )}
        </section>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="learn" className="card reveal flex flex-col p-5">
          <h2 id="learn" className={`${sectionTitle} flex items-center gap-2`}>
            <Lightbulb className="h-4 w-4 text-mute" aria-hidden /> {learn.length ? "Doing it better" : "Close to you"}
          </h2>
          <p className="mt-1 text-sm text-mute">
            {learn.length
              ? "Graded portfolios scoring top marks where yours scores lowest. Worth a look."
              : "Graded portfolios at about your level, in your tier."}
          </p>
          {(learn.length ? learn : close).length > 0 ? (
            <ul className="mt-3 flex-1">
              {(learn.length ? learn : close).map((s) => (
                <li key={s.url} className="border-t border-edge first:border-t-0">
                  <a href={s.path} className="group flex items-center gap-3 rounded-xl px-1 py-2.5 transition hover:bg-raised">
                    <Thumb src={mine.heroes[s.url] ?? null} domain={s.domain} className="aspect-square w-9 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{s.name}</span>
                      <span className="block truncate text-xs text-mute">
                        {s.domain}
                        {"why" in s ? ` · 5/5 for ${String(s.why).toLowerCase()}` : ""}
                      </span>
                    </span>
                    <TierBadge tier={s.tier} />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-xl border border-dashed border-edge-strong p-4 text-sm text-mute">
              No graded portfolio to compare with yet. The comparison fills as more portfolios are graded.
            </p>
          )}
        </section>

        <section aria-labelledby="fights" className="card reveal flex flex-col p-5">
          <h2 id="fights" className={`${sectionTitle} flex items-center gap-2`}>
            <Swords className="h-4 w-4 text-mute" aria-hidden /> Latest face-offs
          </h2>
          {!listed ? (
            <div className="mt-3 flex flex-1 flex-col items-start justify-center gap-3 rounded-xl border border-dashed border-edge-strong p-5 text-sm">
              <p>
                <span className="block font-semibold">Not on the leaderboard yet</span>
                <span className="block text-mute">
                  The list comes from the community&apos;s developer-portfolios collection. Once yours is on it, people vote on it in face-offs and the results show up here.
                </span>
              </p>
              <a href={SITE.submit} target="_blank" rel="noopener noreferrer" className="btn-sheen inline-flex h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold">
                <UsersRound className="h-4 w-4" aria-hidden /> Submit your portfolio
              </a>
            </div>
          ) : fights.length === 0 ? (
            <div className="mt-3 flex flex-1 flex-col items-start justify-center gap-3 rounded-xl border border-dashed border-edge-strong p-5 text-sm">
              <p>
                <span className="block font-semibold">No face-offs yet</span>
                <span className="block text-mute">Yours is in the voting pool. Results show up here as people vote.</span>
              </p>
            </div>
          ) : (
            <>
              <p className="mt-1 text-sm text-mute">
                Won {wins} of the last {fights.length}.
              </p>
              <ul className="mt-3 flex-1">
                {fights.map((f, i) => (
                  <li key={i} className="flex items-center gap-3 border-t border-edge py-2.5 first:border-t-0">
                    <Thumb src={f.other.hero} domain={f.other.domain} className="aspect-square w-9 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className={`font-semibold ${f.won ? "text-up" : "text-down"}`}>{f.won ? "Won" : "Lost"}</span> vs {f.other.domain}
                      </span>
                      <span className="block text-xs text-mute">
                        {new Date(f.at.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {ROUTES.faceoff && (
            <a href={ROUTES.faceoff} className="group mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
              Vote in a face-off <ArrowRight className="nudge h-4 w-4" aria-hidden />
            </a>
          )}
        </section>
      </div>

      {gamesEnabled() && <Badges defs={(BADGES as { id: string; name: string; how: string; hue: number; target: number; counter: string }[]).map(({ id, name, how, hue, target, counter }) => ({ id, name, how, hue, target, counter }))} />}
    </div>
  );
}
