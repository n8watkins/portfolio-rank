"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Flame, RotateCcw, SkipForward, Star, Target, Undo2, Users, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { useSignIn } from "@/components/SignInModal";
import { SiteActions } from "@/components/play/SiteActions";
import { Burst, useCountUp, useReducedMotion } from "@/components/ui/motion";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";
import { useStoredFlag } from "@/lib/client-state";
import { isTextField } from "@/lib/dom";
import { frameOf } from "@/lib/shot-url";

// The face-off on the real votes (/api/rank): two portfolios, pick the one
// you'd hire from, then see how the crowd leans on the cards themselves.
// Rounds of ten with "with the crowd" and a streak; practice votes for
// guests until they sign in. ← and → pick, S or ↓ skips, Enter or → goes on.

type Entry = { name: string; url: string; tagline?: string; elo: number; votes: number; shot?: string | null };
type Pair = { a: Entry; b: Entry; token: string };
type Rater = { signedIn: boolean; login: string | null; anonVotesUsed: number | null; anonVoteLimit: number; stars: number };
type Side = "a" | "b";

const ROUND = 10;
const INTRO_KEY = "pr-faceoff-intro";
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

export function FaceOff({ games, onBadgeCheck }: { games: boolean; onBadgeCheck: (now?: boolean) => void }) {
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
  const [intro, setIntro] = useState(false);
  // Off by default so votes stay honest; remembered in this browser.
  const [showScores, setShowScores] = useStoredFlag(SCORES_KEY);
  const openSignIn = useSignIn();
  const reduced = useReducedMotion();
  const nextRef = useRef<HTMLButtonElement>(null);
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
    const r = data.rater;
    if (r) {
      setRater(r);
      if (!r.signedIn) {
        try {
          setIntro(localStorage.getItem(INTRO_KEY) !== "1");
        } catch {
          setIntro(true);
        }
      }
    }
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
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {}
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
      onBadgeCheck();
      requestAnimationFrame(() => nextRef.current?.focus());
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
      else if (pick !== null && (key === "ArrowRight" || (key === "Enter" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)))) next();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, vote, next, finished]);

  const shares = pair ? { a: shareOf(pair.a.elo, pair.b.elo), b: shareOf(pair.b.elo, pair.a.elo) } : null;
  const canStar = Boolean(rater?.signedIn && rater.stars > 0);

  return (
    <div>
      {/* Progress through the round */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
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
            <Users className="h-4 w-4" aria-hidden /> <span className="font-semibold text-ink tabular-nums">{agreed}</span> with the crowd
          </span>
          <span className="flex items-center gap-1.5">
            <Flame className={`h-4 w-4 ${streak > 1 ? "flicker text-accent" : ""}`} aria-hidden /> streak{" "}
            <span key={streak} className={`font-semibold tabular-nums ${streak > 1 ? "pop-in text-accent" : "text-ink"}`}>
              {streak > 1 ? `x${streak}` : streak}
            </span>
          </span>
        </span>
      </div>

      {intro && rater && !rater.signedIn && !gated && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3.5 text-sm">
          <p className="min-w-0 flex-1">
            <strong>Pick the portfolio you&apos;d rather hire from.</strong> Your first {rater.anonVoteLimit} votes are practice: you see how others lean, and they count once you{" "}
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
        <div className="grid grid-cols-2 gap-3 sm:gap-5">
          {(["a", "b"] as const).map((side) => {
            const e = pair[side];
            const mine = pick === side;
            const state = pick === null ? "" : mine ? "win-pop" : "lose-dim";
            return (
              <div
                key={`${pair.token}-${side}`}
                className={`card group relative min-w-0 overflow-hidden ${pick === null ? "card-hover deal-in" : ""} ${state} ${mine ? "ring-2 ring-accent" : ""}`}
                style={{ "--d": `${side === "a" ? 0 : 90}ms` } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => vote(side)}
                  disabled={pick !== null || busy}
                  aria-label={`Pick ${e.name}`}
                  aria-keyshortcuts={side === "a" ? "ArrowLeft" : "ArrowRight"}
                  aria-pressed={pick === null ? undefined : mine}
                  className="relative block aspect-[390/560] w-full text-left focus-visible:-outline-offset-4 disabled:cursor-default md:aspect-[16/10]"
                >
                  <Frame e={e} />
                  {pick === null && (
                    <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100 md:flex">
                      <span className="rounded-full bg-fill px-4 py-2 text-sm font-bold text-on-fill shadow-lg">Pick this one</span>
                    </span>
                  )}
                  {pick !== null && <Share pct={shares[side]} mine={mine} k={`${pair.token}-${side}`} />}
                </button>
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 p-2.5 sm:flex-nowrap sm:p-4">
                  <span className="w-full min-w-0 sm:w-auto sm:flex-1">
                    <span className="block truncate font-semibold">{e.name}</span>
                    <span className="block truncate text-xs text-mute sm:text-sm">
                      {domainOf(e.url)}
                      {(showScores || pick !== null) && (
                        <span className="tabular-nums">
                          {" "}
                          · ELO {Math.round(e.elo)}
                        </span>
                      )}
                    </span>
                  </span>
                  <SiteActions url={e.url} name={e.name} compact onSaved={() => onBadgeCheck()} />
                  <kbd className={`hidden h-7 min-w-7 place-items-center rounded-md border border-edge px-1.5 text-xs text-mute ${pick === null ? "lg:grid" : ""}`} aria-hidden>
                    {side === "a" ? "←" : "→"}
                  </kbd>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Skeleton in the cards' own shape, so nothing jumps when the pair arrives.
        <div className="grid grid-cols-2 gap-3 sm:gap-5" aria-busy="true">
          {[0, 1].map((k) => (
            <div key={k} aria-hidden className="card overflow-hidden">
              <div className="aspect-[390/560] w-full animate-pulse bg-raised md:aspect-[16/10]" />
              <div className="p-2.5 sm:p-4">
                <div className="h-6 py-1">
                  <div className="h-full w-2/5 animate-pulse rounded bg-raised" />
                </div>
                <div className="h-4 py-0.5 sm:h-5 sm:py-1">
                  <div className="h-full w-3/5 animate-pulse rounded bg-raised" />
                </div>
                <div className="mt-2 h-9 sm:hidden" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results, errors and loading, announced without moving focus. */}
      <p role="status" aria-live="polite" className="sr-only">
        {busy && !pair ? "Loading a pair" : pick && pair && shares ? `You picked ${pair[pick].name}. ${shares[pick]}% of people would pick it. ${LEAN[leanOf(shares[pick])]}` : (note ?? "")}
      </p>

      {!finished && !gated && (pair || loadError) && (
        <div className="mt-4 flex min-h-12 flex-wrap items-center justify-between gap-2">
          {pick === null ? (
            <>
              {note ? (
                <p className="min-w-0 text-sm font-medium text-accent">{note}</p>
              ) : (
                <>
                  <p className="hidden text-sm text-mute md:block">
                    Press <kbd className="rounded border border-edge px-1.5 text-xs">←</kbd> or <kbd className="rounded border border-edge px-1.5 text-xs">→</kbd> to pick,{" "}
                    <kbd className="rounded border border-edge px-1.5 text-xs">S</kbd> to skip.
                  </p>
                  <p className="text-sm text-mute md:hidden">Tap the one you&apos;d hire from.</p>
                </>
              )}
              <label className="flex min-h-11 items-center gap-2 text-xs text-mute max-sm:hidden">
                <input
                  type="checkbox"
                  checked={showScores}
                  onChange={(e) => setShowScores(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-fill)]"
                />
                Show scores before voting
              </label>
              <button type="button" onClick={next} disabled={busy} aria-keyshortcuts="S" className={`${btnGhost} px-3`}>
                <SkipForward className="h-4 w-4" aria-hidden /> Skip
              </button>
            </>
          ) : (
            <>
              <p className="pop-in min-w-0 text-sm" aria-hidden>
                <span className="font-semibold">{shares && LEAN[leanOf(shares[pick])]}</span>{" "}
                <span className="text-mute">
                  {official ? "Counted." : practiceLeft != null ? `Practice vote ${rater!.anonVoteLimit - practiceLeft} of ${rater!.anonVoteLimit}.` : "Practice vote."}
                </span>
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={undo} disabled={busy} className={`${btnGhost} px-3`}>
                  <Undo2 className="h-4 w-4" aria-hidden /> Undo
                </button>
                <button ref={nextRef} type="button" onClick={next} disabled={busy} className={btnPrimary}>
                  {done >= ROUND ? "See results" : "Next pair"} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
