import { Check, Sparkles, Swords, Trophy, X } from "lucide-react";
import { BoardCard } from "@/components/top/BoardCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { EloTierBadge, RankBadge } from "@/components/ui/badges";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary } from "@/components/ui/styles";
import { ROUTES } from "@/lib/nav";
import { AI_VOTE_WEIGHT, isPublicTier } from "@/lib/tiers.mjs";
import type { RankedBoard as Board, RankedRow } from "@/lib/tiers-board";
import type { Why } from "@/lib/leaderboard";

// The leaderboard as one ranked board (tiers by ELO, RANKING_V2 only): by
// ELO, so by tier, each row with its letter (public tiers only), real votes
// and ELO. With the flag off /top is the ELO board as before
// (components/top/Leaderboard.tsx).

const FIRST_PAGE = 50;

export function RankedBoard({ board }: { board: Board }) {
  const { rows } = board;
  return (
    <div className="wrap py-8 sm:py-10">
      <div className="rise min-w-0">
        <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
        <p className="mt-1.5 text-sm text-mute">
          Ranked by ELO from face-off votes. Your tier comes from your place. {board.totalVotes.toLocaleString("en-US")} votes cast.{" "}
          <a href="/grading#tiers" className="font-medium text-accent underline-offset-4 hover:underline">
            How it&apos;s scored
          </a>
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="rise mt-6"
          icon={Trophy}
          title="No portfolios on this board yet."
          action={
            ROUTES.play && (
              <a href={ROUTES.play} className={btnPrimary}>
                <Swords className="h-4 w-4" aria-hidden /> Cast the first votes
              </a>
            )
          }
        >
          It fills in as portfolios are graded.
        </EmptyState>
      ) : (
        <>
          <ul className="rise mt-5 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-mute" style={{ "--d": "60ms" } as React.CSSProperties} aria-label="How to read this">
            <li>
              <strong className="font-semibold text-ink">Start</strong> a rank from automated checks; real votes move it
            </li>
            <li>
              <strong className="font-semibold text-ink">ELO</strong> a person&apos;s vote counts fully, an AI comparison {AI_VOTE_WEIGHT === 0.25 ? "a quarter" : `${AI_VOTE_WEIGHT} of one`}
            </li>
          </ul>
          <BoardCard
            head={<Head />}
            first={rows.slice(0, FIRST_PAGE).map((r) => (
              <Row key={r.url} r={r} />
            ))}
            rest={rows.slice(FIRST_PAGE).map((r) => (
              <Row key={r.url} r={r} />
            ))}
            restCount={Math.max(0, rows.length - FIRST_PAGE)}
          />
          <p className="mt-4 text-xs text-mute">This is a crowd&apos;s and an AI&apos;s view of look and first impression, not a verdict on the developer.</p>
        </>
      )}
    </div>
  );
}

function Head() {
  return (
    <div className="hidden items-center gap-5 border-b border-edge px-5 py-2.5 text-xs font-medium uppercase tracking-wider text-mute md:flex" aria-hidden>
      <span className="w-10 text-right">#</span>
      <span className="flex-1">Portfolio</span>
      <span className="w-12 text-center">Tier</span>
      <span className="w-24 text-right">Real votes</span>
      <span className="w-16 text-right">ELO</span>
    </div>
  );
}

function Row({ r }: { r: RankedRow }) {
  const votes = `${r.votes.toLocaleString("en-US")} ${r.votes === 1 ? "vote" : "votes"}`;
  return (
    <li className="border-b border-edge last:border-b-0">
      <a href={`/p/${encodeURIComponent(r.url)}`} className="group flex items-center gap-3 px-3 py-3 transition hover:bg-raised focus-visible:-outline-offset-2 md:gap-5 md:px-5 md:py-4">
        <span className="flex w-9 shrink-0 justify-end md:w-10">
          <RankBadge rank={r.rank} size={r.rank <= 3 ? "lg" : "md"} />
        </span>
        <span className="w-20 shrink-0 max-sm:hidden md:w-44 lg:w-52">
          <ScreenshotFrame src={r.shot} alt="" domain={r.domain} eager={r.rank <= 3} className="rounded-lg border border-edge transition group-hover:border-edge-strong" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold md:text-[15px]">{r.name}</span>
          <span className="block truncate text-xs text-mute">{r.tagline ?? r.domain}</span>
          {r.why && <WhyChips why={r.why} />}
        </span>
        <span className="flex w-8 justify-center md:w-12">{isPublicTier(r.tier) && <EloTierBadge tier={r.tier} />}</span>
        <span className="hidden w-24 text-right text-sm tabular-nums text-mute md:block">{r.votes.toLocaleString("en-US")}</span>
        <span className="w-[6.5rem] shrink-0 text-right md:w-16">
          <span className="block text-sm font-bold tabular-nums">
            <span className="sr-only">ELO </span>
            {r.elo}
          </span>
          <span className="block whitespace-nowrap text-[11px] tabular-nums text-mute md:hidden">{votes}</span>
        </span>
      </a>
    </li>
  );
}

/** Why it's good, at a glance: the basics as chips and the AI's best note. */
function WhyChips({ why }: { why: Why }) {
  return (
    <span className="mt-2 hidden md:block">
      {why.facts.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          <span className="sr-only">Basics:</span>
          {why.facts.map((f) => (
            <span
              key={f.label}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${f.pass ? "border-up/30 text-ink" : "border-edge text-mute line-through decoration-mute/60"}`}
            >
              {f.pass ? <Check className="h-3 w-3 text-up" aria-label="has" /> : <X className="h-3 w-3" aria-label="missing" />}
              {f.label}
            </span>
          ))}
        </span>
      )}
      {why.best && (
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-mute">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span className="truncate">
            <span className="font-medium text-ink">{why.best.label}:</span> {why.best.note}
          </span>
        </span>
      )}
    </span>
  );
}
