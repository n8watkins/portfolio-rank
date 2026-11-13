import { Bot, Check, Crown, Merge, Sparkles, Split, Swords, Trophy, Users, X } from "lucide-react";
import { BoardCard } from "@/components/top/BoardCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Movement, RankBadge, TierBadge } from "@/components/ui/badges";
import { AI_VOTE_WEIGHT, MIN_FACEOFFS, STARTING_TIER, isPublicTier } from "@/lib/tiers.mjs";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary } from "@/components/ui/styles";
import { ROUTES } from "@/lib/nav";
import type { BoardKind, Entry, Leaderboard as Board, Why } from "@/lib/leaderboard";

// The leaderboard (owner-approved redesign preview): the ranked board (tiers
// by ELO from face-offs, lib/tiers.mjs), with Merged, AI and People as more
// tabs when the ranking views are on. Gold, silver and bronze trophies for
// the top 3, a big screenshot on every row and "why it's good" chips from the
// stored AI grade.

const VIEWS = [
  { key: "rank", href: "/top", label: "Ranked", Icon: Crown, blurb: "Ranked by ELO from face-off votes. Your tier comes from your place." },
  { key: "merged", href: "/top/merged", label: "Merged", Icon: Merge, blurb: "People's votes and the AI grade, weighted together." },
  { key: "ai", href: "/top/ai", label: "AI", Icon: Bot, blurb: "The AI's grade of design, first impression, project stories, writing and memorability." },
  { key: "people", href: "/top/people", label: "People", Icon: Users, blurb: "Head-to-head face-off votes from people only." },
] as const;

const FIRST_PAGE = 50;

/** `views`: the ranking views are on (RANKING_V2), so Merged, AI and People show as tabs beside Ranked. */
export function Leaderboard({ board, views = true }: { board: Board; views?: boolean }) {
  const { kind, rows } = board;
  const view = VIEWS.find((v) => v.key === kind);
  const tabs = views ? VIEWS : [];
  const hasMoves = rows.some((r) => r.move != null);
  const hasSplit = rows.some((r) => r.disagree);
  const hasTies = rows.some((r) => r.tied);

  return (
    <div className="wrap py-8 sm:py-10">
      <div className="rise flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
          <p className="mt-1.5 text-sm text-mute">
            {view?.blurb}{" "}
            {kind === "rank" && board.totalVotes != null && `${board.totalVotes.toLocaleString("en-US")} votes cast. `}
            <a href={kind === "rank" ? "/grading#tiers" : (ROUTES.about ?? "/how")} className="font-medium text-accent underline-offset-4 hover:underline">
              How it&apos;s scored
            </a>
          </p>
        </div>
        {tabs.length > 0 && (
          <nav aria-label="Leaderboard view" className="inline-flex max-w-full overflow-x-auto rounded-lg border border-edge bg-raised p-1">
            {tabs.map(({ key, href, label, Icon }) => (
              <a
                key={key}
                href={href}
                aria-current={kind === key ? "page" : undefined}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm sm:px-3.5 font-medium text-mute transition hover:text-ink aria-[current=page]:bg-card aria-[current=page]:text-ink aria-[current=page]:shadow-[var(--card-hi),var(--card-drop)]"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </a>
            ))}
          </nav>
        )}
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
          It fills in as people vote in the face-off.
        </EmptyState>
      ) : (
        <>
          <ul className="rise mt-5 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-mute" style={{ "--d": "60ms" } as React.CSSProperties} aria-label="How to read this">
            {hasTies && (
              <li>
                <strong className="font-semibold text-ink">=3</strong> equal scores share a place
              </li>
            )}
            {kind === "rank" ? (
              <>
                <li>
                  <strong className="font-semibold text-ink">{STARTING_TIER}</strong> everyone starts here, until {MIN_FACEOFFS} face-offs
                </li>
                <li>
                  <strong className="font-semibold text-ink">ELO</strong> a person&apos;s vote counts fully, an AI comparison {AI_VOTE_WEIGHT === 0.25 ? "a quarter" : `${AI_VOTE_WEIGHT} of one`}
                </li>
                {board.ranked != null && (
                  <li>
                    <strong className="font-semibold text-ink tabular-nums">{board.ranked.toLocaleString("en-US")}</strong> of {board.total.toLocaleString("en-US")} have {MIN_FACEOFFS} face-offs
                  </li>
                )}
              </>
            ) : kind === "merged" || kind === "people" ? (
              <li>
                <strong className="font-semibold text-ink">Likely #2-#5</strong> where it could land, given how many votes it has so far
              </li>
            ) : kind === "ai" ? (
              <li>
                <strong className="font-semibold text-ink">Top 1%</strong> share of graded portfolios at or above it
              </li>
            ) : null}
            {hasMoves && (
              <li className="flex items-center gap-1">
                <Movement move={2} /> places this week
              </li>
            )}
            {hasSplit && (
              <li className="flex items-center gap-1">
                <Split className="h-3.5 w-3.5" aria-hidden /> AI and people strongly disagree
              </li>
            )}
            {kind !== "rank" && (
              <li>
                Tier and ELO from face-offs:{" "}
                <a href="/grading#tiers" className="font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent">
                  how tiers work
                </a>
              </li>
            )}
          </ul>

          <BoardCard
            head={<Head kind={kind} hasMoves={hasMoves} />}
            first={rows.slice(0, FIRST_PAGE).map((r) => (
              <Row key={r.url} r={r} kind={kind} hasMoves={hasMoves} />
            ))}
            rest={rows.slice(FIRST_PAGE).map((r) => (
              <Row key={r.url} r={r} kind={kind} hasMoves={hasMoves} />
            ))}
            restCount={Math.max(0, rows.length - FIRST_PAGE)}
          />
          <p className="mt-4 text-xs text-mute">This is a crowd&apos;s and an AI&apos;s view of look and first impression, not a verdict on the developer.</p>
        </>
      )}
    </div>
  );
}

const scoreLabel = (kind: BoardKind) => (kind === "rank" ? "ELO" : "Score");
/** Face-offs on the ranked board: "4 of 10" until a tier is earned (quarters from AI face-offs dropped), then the count. */
const faceoffText = (r: Entry) => {
  const n = Math.floor(r.faceoffs ?? 0);
  return r.provisional ? `${n} of ${MIN_FACEOFFS}` : String(n);
};

function Head({ kind, hasMoves }: { kind: BoardKind; hasMoves: boolean }) {
  return (
    <div className="hidden items-center gap-5 border-b border-edge px-5 py-2.5 text-xs font-medium uppercase tracking-wider text-mute md:flex" aria-hidden>
      <span className="w-10 text-right">#</span>
      <span className="flex-1">Portfolio</span>
      {hasMoves && <span className="w-12 text-right">Week</span>}
      <span className="w-12 text-center">Tier</span>
      {kind !== "rank" && <span className="w-28 text-right">{kind === "ai" ? "Percentile" : "Likely rank"}</span>}
      {kind === "rank" && <span className="w-24 text-right">Face-offs</span>}
      {kind !== "rank" && <span className="w-14 text-right">ELO</span>}
      <span className="w-16 text-right">{scoreLabel(kind)}</span>
    </div>
  );
}

function Row({ r, kind, hasMoves }: { r: Entry; kind: BoardKind; hasMoves: boolean }) {
  const base = kind === "ai" ? (r.topPct != null ? `top ${r.topPct}%` : null) : kind === "rank" ? `${faceoffText(r)} face-offs` : r.likely ? `likely ${r.likely.replace(/-#/, "-")}` : null;
  // On a phone the ELO column is folded into the line under the score.
  const sub = kind !== "rank" && r.elo != null ? [base, `ELO ${r.elo}`].filter(Boolean).join(" · ") : base;
  return (
    <li className="border-b border-edge last:border-b-0">
      <a href={`/p/${encodeURIComponent(r.url)}`} className="group flex items-center gap-3 px-3 py-3 transition hover:bg-raised focus-visible:-outline-offset-2 md:gap-5 md:px-5 md:py-4">
        <span className="flex w-9 shrink-0 justify-end md:w-10">
          <RankBadge rank={r.rank} place={r.place} tied={r.tied} size={r.place <= 3 ? "lg" : "md"} />
        </span>
        <span className="w-20 shrink-0 max-sm:hidden md:w-44 lg:w-52">
          <ScreenshotFrame src={r.shot} alt="" domain={r.domain} eager={r.place <= 3} className="rounded-lg border border-edge transition group-hover:border-edge-strong" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold md:text-[15px]">{r.name}</span>
            {r.disagree && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-edge-strong px-1.5 py-0.5 text-[11px] font-medium text-mute"
                title={`AI ranks it #${r.disagree.ai}, people rank it #${r.disagree.people}`}
              >
                <Split className="h-3 w-3" aria-hidden />
                <span className="sr-only">AI and people disagree:</span>
                <span className="max-sm:sr-only">
                  AI #{r.disagree.ai} · People #{r.disagree.people}
                </span>
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-mute">{r.tagline ?? r.domain}</span>
          {r.why && <WhyChips why={r.why} />}
        </span>
        {hasMoves && <span className="hidden w-12 justify-end md:flex">{r.move != null && <Movement move={r.move} className="nudge-up" />}</span>}
        {/* The tier by ELO (public tiers only) on every board; on the ranked board it shows on phones too. */}
        <span className={`w-12 justify-center ${kind === "rank" ? "flex max-md:w-8" : "hidden md:flex"}`}>{isPublicTier(r.tier) && <TierBadge tier={r.tier!} />}</span>
        {kind !== "rank" && (
          <span className="hidden w-28 text-right text-sm tabular-nums text-mute md:block">{kind === "ai" ? (r.topPct != null ? `Top ${r.topPct}%` : "") : r.likely}</span>
        )}
        {kind === "rank" && <span className="hidden w-24 text-right text-sm tabular-nums text-mute md:block">{faceoffText(r)}</span>}
        {kind !== "rank" && (
          <span className="hidden w-14 text-right text-sm tabular-nums text-mute md:block">
            <span className="sr-only">ELO </span>
            {r.elo ?? "-"}
          </span>
        )}
        <span className="w-[4.75rem] shrink-0 text-right md:w-16">
          <span className="block text-sm font-bold tabular-nums">
            <span className="sr-only">{scoreLabel(kind)} </span>
            {r.score}
          </span>
          {sub && <span className="block whitespace-nowrap text-[11px] tabular-nums text-mute md:hidden">{sub}</span>}
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
