"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Flame, RotateCcw, SkipForward, Star, Target, Undo2, Users, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { useSignIn } from "@/components/SignInModal";
import { ChecksSummary, DetailsPanel, GradeLine, PlayActions, Record, SiteLink } from "@/components/play/PlayCardParts";
import type { PlayCard } from "@/lib/play/card";
import { Burst, useCountUp, useReducedMotion } from "@/components/ui/motion";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";
import { INTRO_COOKIE } from "@/components/play/intro";
import { useStoredFlag } from "@/lib/client-state";
import { isTextField } from "@/lib/dom";
import { frameOf } from "@/lib/shot-url";

// The face-off on the real votes (/api/rank): two portfolios, pick the one
// you'd hire from, then see how the crowd leans on the cards themselves.
// Rounds of ten with "with the crowd" and a streak; practice votes for
// guests until they sign in. ← and → pick, S or ↓ skips, Enter, N or → goes
// on, D opens both Details panels. Each card shows the facts beside a smaller
// screenshot; the scores (tier, "top N%", win rate, ELO) wait for the vote
// unless "Show scores before voting" is on.

type Entry = { name: string; url: string; tagline?: string; elo: number; votes: number; shot?: string | null; liked?: boolean; card?: PlayCard | null };
type Pair = { a: Entry; b: Entry; token: string };
type Rater = { signedIn: boolean; login: string | null; anonVotesUsed: number | null; anonVoteLimit: number; stars: number };
type Side = "a" | "b";

const ROUND = 10;
const SCORES_KEY = "pr-show-scores";

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * How the crowd leans: the chance the face-off's ratings give each side
 * (ELO's expected score), as a share of people who'd pick it. Pairs rarely
 * repeat among thousands of sites, so a count of votes on this exact pair
 * would almost never say anything.
 */
const shareOf = (mine: number, theirs: number) => Math.round(100 / (1 + Math.pow(10, (theirs - mine) / 400)));

const leanOf = (share: number) => (share > 50 ? "with" : share < 50 ? "under" : "even");
const LEAN = { with: "With the crowd.", under: "You picked the underdog.", even: "A dead heat for the crowd." } as const;

function Frame({ e }: { e: Entry }) {
  const [failed, setFailed] = useState(false);
  const domain = domainOf(e.url);
  if (!e.shot || failed)
    return (
      <span role="img" aria-label={`No screenshot of ${domain}`} className="grid h-full w-full place-items-center bg-raised p-3 text-center text-xs break-all text-mute">
        {domain}
      </span>
    );
  return (
    <picture>
      <source media="(max-width: 767px)" srcSet={frameOf(e.shot, "mobile.jpg")} />
      <img
        src={frameOf(e.shot, "hero.jpg")}
        alt={`Screenshot of ${domain}`}
        fetchPriority="high"
        onError={() => setFailed(true)}
        className="h-full w-full bg-raised object-cover object-top"
      />
    </picture>
  );
}

/** The crowd's share on a card after the vote: counts up, the bar fills. */
function Share({ pct, mine, k }: { pct: number; mine: boolean; k: string }) {
  const n = useCountUp(pct, k);
  return (
    <span className="absolute inset-x-0 bottom-0 block bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 pt-12 text-white sm:p-4">
      {mine && (
        <Burst on>
          <span className="pop-in mb-2 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-xs font-bold text-on-fill">
            <Check className="h-3 w-3" aria-hidden /> Your pick
          </span>
        </Burst>
      )}
      <span className="block text-3xl font-bold tabular-nums sm:text-4xl">{n}%</span>
      <span className="block text-xs text-white/80">of people would pick this</span>
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/20" aria-hidden>
        <span className={`bar-fill block h-full rounded-full ${mine ? "bg-fill" : "bg-white/70"}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function FaceOff({ games, intro: introAtFirst, onBadgeCheck }: { games: boolean; intro: boolean; onBadgeCheck: (now?: boolean) => void }) {
  const [pair, setPair] = useState<Pair | null>(null);
  const [rater, setRater] = useState<Rater | null>(null);
  const [pick, setPick] = useState<Side | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [official, setOfficial] = useState(false);
  const [done, setDone] = useState(0);
  const [agreed, setAgreed] = useState(0);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  // A guest's practice intro, until they vote or dismiss it (drawn by the server: no shift).
  const [intro, setIntro] = useState(introAtFirst);
  // Off by default so votes stay honest; remembered in this browser.
  const [showScores, setShowScores] = useStoredFlag(SCORES_KEY);
  // Which side's Details panel is open; a new pair starts closed.
  const [openSide, setOpenSide] = useState({ a: false, b: false });
  const openSignIn = useSignIn();
  const reduced = useReducedMotion();
  const nextRef = useRef<HTMLButtonElement>(null);
  // Bumped when a vote is counted: focus then moves to Next pair, once it is on the page.
  const [counted, setCounted] = useState(0);
  useEffect(() => {
    if (counted) nextRef.current?.focus();
  }, [counted]);
  const seq = useRef(0);

  const finished = done >= ROUND && pick === null;
  const gated = rater !== null && !rater.signedIn && (rater.anonVotesUsed ?? 0) >= rater.anonVoteLimit;
  const practiceLeft = rater && !rater.signedIn ? rater.anonVoteLimit - (rater.anonVotesUsed ?? 0) : null;

  const signIn = useCallback(
    (out: boolean) =>
      openSignIn(
        out
          ? { title: "You're out of practice votes", body: "Sign in to keep voting. Your practice votes convert into official ones.", skipLabel: "Not now" }
          : { title: "Make your votes count", body: "Sign in so your picks move the official rankings. Your practice votes convert when you do." }
      ),
    [openSignIn]
  );

  const load = useCallback(async () => {
    const n = ++seq.current;
    setBusy(true);
    let res: Response;
    let data: (Pair & { rater?: Rater; error?: string }) | null = null;
    try {
      res = await fetch("/api/rank", { cache: "no-store" });
      data = await res.json();
    } catch {
      if (n === seq.current) {
        setLoadError(true);
        setBusy(false);
      }
      return;
    }
    if (n !== seq.current) return;
    if (res.status === 429) {
      setNote(data?.error === "signin_required" ? "You've drawn a lot of pairs. Sign in to keep going." : "You've skipped a lot this hour. Take a break and come back soon.");
      setBusy(false);
      return;
    }
    if (!res.ok || !data?.a || !data?.b) {
      setLoadError(true);
      setBusy(false);
      return;
    }
    setLoadError(false);
    setPair({ a: data.a, b: data.b, token: data.token });
    setOpenSide({ a: false, b: false });
    const r = data.rater;
    if (r) setRater(r);
    setPick(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    // load() sets state only after its fetch settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const dismissIntro = () => {
    setIntro(false);
    document.cookie = `${INTRO_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  };

  const vote = useCallback(
    async (side: Side, star = false) => {
      if (!pair || busy || pick || gated || finished) return;
      const other: Side = side === "a" ? "b" : "a";
      setBusy(true);
      setPick(side); // at once: the winner pops, the other dims
      setNote(null);
      let res: Response;
      let data: { error?: string; official?: boolean; anonVotesUsed?: number | null; stars?: number };
      try {
        res = await fetch("/api/rank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: pair[side].url, loser: pair[other].url, star, token: pair.token }),
        });
        data = await res.json();
      } catch {
        setNote("That vote didn't go through. Try again.");
        setPick(null);
        setBusy(false);
        return;
      }
      const undoPick = (msg: string) => {
        setNote(msg);
        setPick(null);
        setBusy(false);
      };
      if (res.status === 403 && data.error === "signin_required") {
        setRater((r) => (r ? { ...r, anonVotesUsed: r.anonVoteLimit } : r));
        signIn(true);
        return undoPick("You're out of practice votes.");
      }
      if (res.status === 403 && data.error === "account_too_new") return undoPick("Votes from GitHub accounts this new don't count yet. Thanks for looking!");
      if ((res.status === 403 && data.error === "stale_matchup") || res.status === 409) {
        setNote(res.status === 409 ? "You already voted on this pair. Here's a fresh one." : "That pair expired. Here's a fresh one.");
        load();
        return;
      }
      if (res.status === 429) return undoPick(data.error === "too_fast" ? "Easy there: give each pair a real look before voting." : "That's today's vote limit. Come back tomorrow!");
      if (!res.ok) return undoPick("That vote didn't go through. Try again.");

      if (!reduced) navigator.vibrate?.(12);
      setOfficial(Boolean(data.official));
      const used = data.anonVotesUsed;
      const stars = data.stars;
      setRater((r) => (r ? { ...r, ...(typeof used === "number" ? { anonVotesUsed: used } : {}), ...(typeof stars === "number" ? { stars } : {}) } : r));
      setIntro(false);
      const lean = leanOf(shareOf(pair[side].elo, pair[other].elo));
      setDone((d) => d + 1);
      // A dead heat is neither with nor against the crowd: the streak holds.
      if (lean === "with") setAgreed((a) => a + 1);
      if (lean !== "even") {
        const s = lean === "with" ? streak + 1 : 0;
        setStreak(s);
        setBest((b) => Math.max(b, s));
      }
      setBusy(false);
      setCounted((c) => c + 1);
      onBadgeCheck();
    },
    [pair, busy, pick, gated, finished, reduced, streak, signIn, load, onBadgeCheck]
  );

  const next = useCallback(() => {
    if (busy) return;
    setNote(null);
    // The tenth vote ends the round: its summary first, a new pair after.
    if (done >= ROUND && pick !== null) setPick(null);
    else load();
  }, [busy, done, pick, load]);

  const undo = useCallback(async () => {
    if (!pick || busy || !pair) return;
    setBusy(true);
    const side = pick;
    const withCrowd = leanOf(shareOf(pair[side].elo, pair[side === "a" ? "b" : "a"].elo)) === "with";
    try {
      const res = await fetch("/api/rank/undo", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setNote("Nothing to undo.");
        setBusy(false);
        return;
      }
      setRater((r) =>
        r ? { ...r, ...(typeof data.anonVotesUsed === "number" ? { anonVotesUsed: data.anonVotesUsed } : {}), ...(typeof data.stars === "number" ? { stars: data.stars } : {}) } : r
      );
      setDone((d) => Math.max(0, d - 1));
      if (withCrowd) setAgreed((a) => Math.max(0, a - 1));
      setStreak(0);
      // A vote spends its pair, so the next pick is on a fresh one.
      setNote("Undid your last vote. Here's a fresh pair.");
      load();
    } catch {
      setNote("Undo failed. Try again.");
      setBusy(false);
    }
  }, [pick, busy, pair, load]);

  const again = () => {
    setDone(0);
    setAgreed(0);
    setStreak(0);
    setBest(0);
    load();
  };

  // Shortcuts stand down while a dialog is open, while typing, for held-down
  // repeats and with modifiers (Alt+← is Back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isModalOpen() || isTextField(e.target) || finished) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (pick === null && key === "ArrowLeft") vote("a");
      else if (pick === null && key === "ArrowRight") vote("b");
      else if (pick === null && (key === "s" || key === "ArrowDown")) next();
      else if (pick !== null && (key === "ArrowRight" || key === "n" || (key === "Enter" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)))) next();
      else if (key === "d" && pair) setOpenSide((o) => (o.a && o.b ? { a: false, b: false } : { a: true, b: true }));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, vote, next, finished, pair]);

  const shares = pair ? { a: shareOf(pair.a.elo, pair.b.elo), b: shareOf(pair.b.elo, pair.a.elo) } : null;
  const canStar = Boolean(rater?.signedIn && rater.stars > 0);
  // Scores (ELO, tier, "top N%", win rate) show after the vote, or before it when asked.
  const reveal = showScores || pick !== null;
  const kbd = "inline-grid h-6 min-w-6 place-items-center rounded-md border border-edge px-1 text-[11px] font-semibold text-mute";

  return (
    <div>
      {/* The question, the round and the score in one line. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 sm:mb-4">
        <h2 className="w-full text-base font-bold tracking-tight sm:w-auto sm:text-xl">Which one would you hire from?</h2>
        <div className="flex min-w-[10rem] flex-1 items-center gap-3">
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {Math.min(done, ROUND)} / {ROUND}
          </span>
          <ol className="flex min-w-16 flex-1 gap-1" aria-label={`Vote ${Math.min(done, ROUND)} of ${ROUND} this round`}>
            {Array.from({ length: ROUND }, (_, k) => (
              <li key={k} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${k < done ? "bg-fill" : "bg-edge"}`} />
            ))}
          </ol>
        </div>
        <span className="flex items-center gap-4 text-sm text-mute">
          <span className="flex items-center gap-1.5" title="Picked the side most people would">
            <Users className="h-4 w-4" aria-hidden /> <span className="font-semibold text-ink tabular-nums">{agreed}</span> <span className="max-sm:sr-only">with the crowd</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Flame className={`h-4 w-4 ${streak > 1 ? "flicker text-accent" : ""}`} aria-hidden /> streak{" "}
            <span key={streak} className={`font-semibold tabular-nums ${streak > 1 ? "pop-in text-accent" : "text-ink"}`}>
              {streak > 1 ? `x${streak}` : streak}
            </span>
          </span>
        </span>
      </div>

      {intro && !rater?.signedIn && !gated && (
        <div className="mb-3 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3 text-sm">
          <p className="min-w-0 flex-1">
            <strong>Pick the portfolio you&apos;d rather hire from.</strong> Your first {rater?.anonVoteLimit ?? 10} votes are practice: you see how others lean, and they count once you{" "}
            <button type="button" onClick={() => signIn(false)} className="font-semibold text-accent underline underline-offset-2">
              sign in
            </button>
            .
          </p>
          <button type="button" onClick={dismissIntro} aria-label="Dismiss" className="-m-2 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-mute hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {gated ? (
        <section aria-labelledby="gated" className="card pop-in grid place-items-center gap-2 px-6 py-14 text-center">
          <span className="icon-tile h-14 w-14">
            <Target className="h-7 w-7" aria-hidden />
          </span>
          <h2 id="gated" className="mt-3 text-2xl font-bold tracking-tight">
            You&apos;re out of practice votes
          </h2>
          <p className="max-w-md text-mute">Sign in to keep voting. Your {rater?.anonVoteLimit} practice votes convert into official ones, and everything after counts too.</p>
          <button type="button" onClick={() => signIn(true)} className={`${btnPrimary} mt-4`}>
            Sign in
          </button>
        </section>
      ) : finished ? (
        <section aria-labelledby="round-done" className="card pop-in grid place-items-center gap-2 px-6 py-14 text-center">
          <span className="icon-tile h-14 w-14">
            <Target className="h-7 w-7" aria-hidden />
          </span>
          <h2 id="round-done" className="mt-3 text-2xl font-bold tracking-tight">
            Round complete
          </h2>
          <p className="text-mute">
            You picked with the crowd {agreed} of {ROUND} times. Best streak: {best}.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={again} autoFocus className={btnPrimary}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Play another round
            </button>
            {games && (
              <a href="/play?mode=guess" className={btnSecondary}>
                Try Guess the percentile
              </a>
            )}
          </div>
        </section>
      ) : loadError && !pair ? (
        <div role="alert" className="card grid place-items-center gap-2 px-6 py-14 text-center">
          <p className="font-semibold">Couldn&apos;t load a pair.</p>
          <p className="text-sm text-mute">Check your connection and try again.</p>
          <button type="button" onClick={load} className={`${btnPrimary} mt-3`}>
            Retry
          </button>
        </div>
      ) : pair && shares ? (
        // Cards first, then each side's Details: below its own card from md
        // up, full width under the pair on a phone (the columns are narrow).
        <div className="grid grid-cols-2 items-start gap-x-3 gap-y-3 sm:gap-x-5">
          {(["a", "b"] as const).map((side) => {
            const e = pair[side];
            const mine = pick === side;
            const state = pick === null ? "" : mine ? "win-pop" : "lose-dim";
            return (
              <article
                key={`${pair.token}-${side}`}
                aria-label={e.name}
                className={`card group/card relative flex min-w-0 flex-col overflow-hidden ${pick === null ? "deal-in" : ""} ${state} ${mine ? "ring-2 ring-accent" : ""}`}
                style={{ "--d": `${side === "a" ? 0 : 90}ms` } as React.CSSProperties}
              >
                <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                  <button
                    type="button"
                    onClick={() => vote(side)}
                    disabled={pick !== null || busy}
                    aria-label={`Pick ${e.name}`}
                    aria-keyshortcuts={side === "a" ? "ArrowLeft" : "ArrowRight"}
                    aria-pressed={pick === null ? undefined : mine}
                    className="group relative block aspect-[390/330] w-full overflow-hidden text-left focus-visible:-outline-offset-4 disabled:cursor-default md:aspect-[16/10] lg:border-r lg:border-edge"
                  >
                    <Frame e={e} />
                    {pick === null && (
                      <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100 md:flex">
                        <span className="rounded-full bg-fill px-4 py-2 text-sm font-bold text-on-fill shadow-lg">Pick this one</span>
                      </span>
                    )}
                    {pick !== null && <Share pct={shares[side]} mine={mine} k={`${pair.token}-${side}`} />}
                  </button>
                  <div className="flex min-w-0 flex-col gap-2 p-2.5 sm:p-4">
                    <div className="min-w-0">
                      <h3 className="line-clamp-2 leading-snug font-semibold sm:truncate sm:text-lg">{e.name}</h3>
                      {e.tagline && <p className="mt-0.5 line-clamp-2 text-xs text-mute sm:text-sm">{e.tagline}</p>}
                      <SiteLink url={e.url} className="mt-0.5 max-w-full text-xs sm:text-sm" />
                    </div>
                    {e.card && e.card.roles.length > 0 && (
                      <ul className="flex flex-wrap gap-1 max-sm:hidden" aria-label="Roles">
                        {e.card.roles.map((r) => (
                          <li key={r} className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-medium text-mute">
                            {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    <GradeLine card={e.card ?? null} reveal={reveal} hint="After you pick" />
                    <ChecksSummary card={e.card ?? null} dense />
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Record card={e.card ?? null} reveal={reveal} />
                      {reveal && <span className="text-xs text-mute tabular-nums">ELO {Math.round(e.elo)}</span>}
                    </span>
                  </div>
                </div>
                <div className="mt-auto flex flex-col gap-2 border-t border-edge p-2.5 sm:p-3 lg:flex-row lg:items-center">
                  <div className="min-w-0 lg:flex-1">
                    <PlayActions
                      url={e.url}
                      name={e.name}
                      liked={e.liked}
                      detailsId={`details-${side}`}
                      open={openSide[side]}
                      onDetails={() => setOpenSide((o) => ({ ...o, [side]: !o[side] }))}
                      onSaved={() => onBadgeCheck()}
                    />
                  </div>
                  {pick === null && (
                    <button
                      type="button"
                      onClick={() => vote(side)}
                      disabled={busy}
                      tabIndex={-1}
                      aria-hidden
                      className={`${btnSecondary} shrink-0 gap-2 border-accent/50 max-md:hidden`}
                    >
                      {side === "a" && <kbd className={kbd}>←</kbd>}
                      Pick this one
                      {side === "b" && <kbd className={kbd}>→</kbd>}
                    </button>
                  )}
                </div>
                {canStar && pick === null && (
                  <button
                    type="button"
                    onClick={() => vote(side, true)}
                    disabled={busy}
                    aria-label={`Super-vote ${e.name}: spend a Superstar for double weight`}
                    title="Spend a Superstar: double weight and a Most Loved star"
                    className="absolute top-2 left-2 z-10 inline-flex h-9 items-center gap-1 rounded-full bg-black/55 px-3 text-xs font-bold text-white backdrop-blur transition hover:bg-fill hover:text-on-fill"
                  >
                    <Star className="h-3.5 w-3.5" aria-hidden /> Super
                  </button>
                )}
              </article>
            );
          })}
          {(["a", "b"] as const).map((side) =>
            openSide[side] ? (
              <DetailsPanel
                key={`${pair.token}-details-${side}`}
                id={`details-${side}`}
                url={pair[side].url}
                name={pair[side].name}
                reveal={reveal}
                className={`col-span-2 md:col-span-1 ${side === "b" ? "md:col-start-2" : "md:col-start-1"}`}
              />
            ) : null
          )}
        </div>
      ) : (
        // Skeleton in the cards' own shape, so nothing jumps when the pair arrives.
        <div className="grid grid-cols-2 gap-3 sm:gap-5" aria-busy="true">
          {[0, 1].map((k) => (
            <div key={k} aria-hidden className="card overflow-hidden">
              <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <div className="aspect-[390/330] w-full animate-pulse bg-raised md:aspect-[16/10]" />
                <div className="grid content-start gap-2 p-2.5 sm:p-4">
                  <div className="h-5 w-3/5 animate-pulse rounded bg-raised" />
                  <div className="h-4 w-4/5 animate-pulse rounded bg-raised" />
                  <div className="h-6 w-2/5 animate-pulse rounded bg-raised" />
                  <div className="h-6 w-3/5 animate-pulse rounded bg-raised" />
                </div>
              </div>
              <div className="h-[6.4rem] border-t border-edge lg:h-[4.25rem]" />
            </div>
          ))}
        </div>
      )}

      {/* Results, errors and loading, announced without moving focus. */}
      <p role="status" aria-live="polite" className="sr-only">
        {busy && !pair ? "Loading a pair" : pick && pair && shares ? `You picked ${pair[pick].name}. ${shares[pick]}% of people would pick it. ${LEAN[leanOf(shares[pick])]}` : (note ?? "")}
      </p>

      {/* The decision bar: stays in view (above the phone's tab bar), where the thumb and eye already are. */}
      {!finished && !gated && (pair || loadError) && (
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-1 mt-3 lg:bottom-0">
          <div
            className={`flex min-h-14 items-center gap-2 rounded-2xl border border-edge bg-card/92 p-1.5 shadow-[var(--card-hi),var(--card-drop)] backdrop-blur sm:p-2 ${
              pick === null ? "max-md:grid max-md:grid-cols-[1fr_auto_1fr]" : ""
            }`}
          >
            {pick === null ? (
              <>
                <button type="button" onClick={() => vote("a")} disabled={busy || !pair} aria-keyshortcuts="ArrowLeft" className={`${btnSecondary} flex-1 px-2 whitespace-nowrap md:hidden`}>
                  <ArrowLeft className="h-4 w-4" aria-hidden /> Pick left
                </button>
                <p className="hidden min-w-0 flex-1 px-2 text-sm text-mute md:block">
                  {note ? (
                    <span className="font-medium text-accent">{note}</span>
                  ) : (
                    <>
                      <kbd className={kbd}>←</kbd> <kbd className={kbd}>→</kbd> pick · <kbd className={kbd}>S</kbd> skip · <kbd className={kbd}>D</kbd> details
                    </>
                  )}
                </p>
                <label className="hidden min-h-11 items-center gap-2 px-2 text-xs text-mute md:flex">
                  <input type="checkbox" checked={showScores} onChange={(e) => setShowScores(e.target.checked)} className="h-4 w-4 accent-[var(--color-fill)]" />
                  Show scores before voting
                </label>
                <button type="button" onClick={next} disabled={busy} aria-keyshortcuts="S" className={`${btnGhost} shrink-0 px-3`}>
                  <SkipForward className="h-4 w-4" aria-hidden /> Skip
                </button>
                <button type="button" onClick={() => vote("b")} disabled={busy || !pair} aria-keyshortcuts="ArrowRight" className={`${btnSecondary} flex-1 px-2 whitespace-nowrap md:hidden`}>
                  Pick right <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </>
            ) : (
              <>
                <p className="pop-in min-w-0 flex-1 px-2 text-sm" aria-hidden>
                  <span className="font-semibold">{shares && LEAN[leanOf(shares[pick])]}</span>{" "}
                  <span className="text-mute max-sm:block max-sm:text-xs">
                    {official ? "Counted." : practiceLeft != null ? `Practice vote ${rater!.anonVoteLimit - practiceLeft} of ${rater!.anonVoteLimit}.` : "Practice vote."}
                  </span>
                </p>
                <button type="button" onClick={undo} disabled={busy} className={`${btnGhost} shrink-0 px-3 max-sm:px-2`}>
                  <Undo2 className="h-4 w-4" aria-hidden /> Undo
                </button>
                <button ref={nextRef} type="button" onClick={next} disabled={busy} aria-keyshortcuts="Enter N ArrowRight" className={`${btnPrimary} shrink-0 whitespace-nowrap max-sm:px-4`}>
                  {done >= ROUND ? "See results" : "Next pair"} <kbd className="hidden rounded border border-on-fill/30 px-1 text-[11px] md:inline">Enter</kbd>
                  <ArrowRight className="nudge h-4 w-4 md:hidden" aria-hidden />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
