"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ExternalLink, Flame, MousePointerClick, RotateCcw, Share2, Target, Trophy, Undo2, Users, X } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { isModalOpen } from "@/components/Modal";
import { useSignIn } from "@/components/SignInModal";
import { PlaySummary, prefetchPlayData } from "@/components/Diagnostics";
import { DetailsPanel, EloLine, NameLine } from "@/components/play/PlayCardParts";
import { ViewControls } from "@/components/play/ViewControls";
import { animated, useViewPrefs } from "@/lib/play/view-prefs";
import { Burst, useCountUp, useReducedMotion } from "@/components/ui/motion";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { INTRO_COOKIE } from "@/components/play/intro";
import { isTextField } from "@/lib/dom";
import { frameOf } from "@/lib/shot-url";

// The face-off on the real votes (/api/rank): two portfolios, pick the one
// you'd hire from, then see how the crowd leans on the cards themselves.
// Rounds of five with "with the crowd" and a streak. Guests vote without
// interruption (their votes are practice: logged, never counted, and up to
// ANON_VOTE_LIMIT convert when they sign in); sign-in is offered at the end
// of a round, and the round is kept in sessionStorage so a sign-in returns to
// it. Clicking a screenshot or the centered Pick picks it; ← and → pick, S or
// ↓ skips ("Can't decide, skip"), Enter, N or → goes on. "About this
// portfolio" (its link preview, Lighthouse scores and polish checklist) is shown while deciding;
// only the record (win rate) waits for the vote. No portfolio is shown twice
// in a session (?seen=, kept in sessionStorage).

type Entry = {
  id?: number;
  name: string;
  url: string;
  tagline?: string;
  elo: number;
  votes: number;
  shot?: string | null;
  liked?: boolean;
};
type Pair = { a: Entry; b: Entry; token: string };
type Rater = {
  signedIn: boolean;
  login: string | null;
  anonVotesUsed: number | null;
  anonVoteLimit: number;
  stars: number;
};
type Side = "a" | "b";

const ROUND = 5;
/** Sites already shown in this tab's session (feed indices), so no portfolio comes back. */
const SEEN_KEY = "pr-faceoff-seen";
const SEEN_MAX = 400;

function readSeen(): number[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
function addSeen(ids: (number | undefined)[]) {
  try {
    const next = [...new Set([...readSeen(), ...ids.filter((x): x is number => Number.isInteger(x))])].slice(-SEEN_MAX);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* storage off: repeats are possible, nothing breaks */
  }
}

type RoundState = {
  done: number;
  agreed: number;
  streak: number;
  best: number;
};
const EMPTY_ROUND: RoundState = { done: 0, agreed: 0, streak: 0, best: 0 };
const ROUND_KEY = "pr-faceoff-round";

function readRound(): RoundState {
  try {
    const v = JSON.parse(sessionStorage.getItem(ROUND_KEY) ?? "null");
    if (v && [v.done, v.agreed, v.streak, v.best].every((x) => Number.isInteger(x) && x >= 0))
      return {
        done: Math.min(v.done, ROUND),
        agreed: v.agreed,
        streak: v.streak,
        best: v.best,
      };
  } catch {
    /* storage off */
  }
  return EMPTY_ROUND;
}
function writeRound(r: RoundState) {
  try {
    sessionStorage.setItem(ROUND_KEY, JSON.stringify(r));
  } catch {
    /* storage off: the round lives in memory only */
  }
}

/** Draws a pair from /api/rank, leaving out the sites this session has seen. */
async function drawPair(): Promise<{ res: { ok: boolean; status: number }; data: (Pair & { rater?: Rater; error?: string }) | null }> {
  const seen = readSeen();
  const r = await fetch(seen.length ? `/api/rank?seen=${seen.join(",")}` : "/api/rank", { cache: "no-store" });
  return { res: { ok: r.ok, status: r.status }, data: await r.json() };
}

/** Starts loading a portfolio's screenshot and stored details, so its card fills at once. */
function warm(e: Entry) {
  if (e.shot) {
    const img = new Image();
    img.decoding = "async";
    img.src = frameOf(e.shot, "hero.jpg");
  }
  prefetchPlayData(e.url);
}

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
const LEAN = {
  with: "With the crowd.",
  under: "You picked the underdog.",
  even: "A dead heat for the crowd.",
} as const;

function Frame({ e }: { e: Entry }) {
  const [failed, setFailed] = useState(false);
  const domain = domainOf(e.url);
  if (!e.shot || failed)
    return (
      <span role="img" aria-label={`No screenshot of ${domain}`} className="grid h-full w-full place-items-center bg-raised p-3 text-center text-xs break-all text-mute">
        {domain}
      </span>
    );
  // The desktop frame at every width: on a phone the two cards stack, each a
  // landscape screenshot across the full width.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={frameOf(e.shot, "hero.jpg")} alt={`Screenshot of ${domain}`} fetchPriority="high" onError={() => setFailed(true)} className="h-full w-full bg-raised object-cover object-top" />
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
  // After a vote, the portfolio in the spotlight (first the one picked).
  const spotlightRef = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState<Side | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [official, setOfficial] = useState(false);
  // The round so far; kept in this tab's session so a reload or a sign-in
  // comes back to the same round and position.
  const [round, setRound] = useState<RoundState>(EMPTY_ROUND);
  const { done, agreed, streak, best } = round;
  useEffect(() => {
    // Read once after hydration (sessionStorage is not on the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRound(readRound());
  }, []);
  const saveRound = useCallback((f: (r: RoundState) => RoundState) => {
    setRound((r) => {
      const next = f(r);
      writeRound(next);
      return next;
    });
  }, []);
  // A guest's practice intro, until they vote or dismiss it (drawn by the server: no shift).
  const [intro, setIntro] = useState(introAtFirst);
  // What the viewer chose to see (Simple, Detailed or their own mix).
  const { prefs, choose, toggle } = useViewPrefs();
  // Simple has its own strip; Detailed and custom views show the chosen parts.
  const simple = prefs.mode === "simple";
  const openSignIn = useSignIn();
  const reduced = useReducedMotion();
  const nextRef = useRef<HTMLButtonElement>(null);
  // Bumped when a vote is counted: focus then moves to Next pair, once it is on the page.
  const [counted, setCounted] = useState(0);
  useEffect(() => {
    // The spotlight lands a frame after the vote (view transition): focus Next once it is there.
    if (!counted || !focus) return;
    nextRef.current?.focus({ preventScroll: true });
    // On a phone the spotlight may sit above the fold: bring its top into view.
    if (window.matchMedia("(max-width: 767px)").matches) spotlightRef.current?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [counted, focus, reduced]);
  const seq = useRef(0);

  const finished = done >= ROUND && pick === null;
  const guest = rater !== null && !rater.signedIn;

  // Never a wall mid-play: sign-in is offered at the end of a round (and in
  // the guest intro). After it, the page comes back here, to the same round.
  const signIn = useCallback(
    () =>
      openSignIn({
        title: "Save your votes and badges",
        body: `Sign in and your votes count on the People board (up to ${rater?.anonVoteLimit ?? 10} from before you signed in), and your badges stay with you.`,
      }),
    [openSignIn, rater?.anonVoteLimit],
  );

  // A pair drawn ahead of time (after a vote), used by the next load().
  const upcoming = useRef<ReturnType<typeof drawPair> | null>(null);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setBusy(true);
    let res: { ok: boolean; status: number };
    let data: (Pair & { rater?: Rater; error?: string }) | null = null;
    try {
      // The pair drawn ahead while the last one was on screen, else a new draw.
      const ahead = upcoming.current;
      upcoming.current = null;
      ({ res, data } = await (ahead ?? drawPair()));
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
    addSeen([data.a.id, data.b.id]);
    warm(data.a);
    warm(data.b);
    const r = data.rater;
    if (r) setRater(r);
    setPick(null);
    setFocus(null);
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
      if (!pair || busy || pick || finished) return;
      const other: Side = side === "a" ? "b" : "a";
      setBusy(true);
      setPick(side); // at once: the winner pops, the other dims
      setNote(null);
      let res: Response;
      let data: {
        error?: string;
        official?: boolean;
        anonVotesUsed?: number | null;
        stars?: number;
      };
      try {
        res = await fetch("/api/rank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winner: pair[side].url,
            loser: pair[other].url,
            star,
            token: pair.token,
          }),
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
      setRater((r) =>
        r
          ? {
              ...r,
              ...(typeof used === "number" ? { anonVotesUsed: used } : {}),
              ...(typeof stars === "number" ? { stars } : {}),
            }
          : r,
      );
      setIntro(false);
      const lean = leanOf(shareOf(pair[side].elo, pair[other].elo));
      // A dead heat is neither with nor against the crowd: the streak holds.
      saveRound((r) => {
        const s = lean === "even" ? r.streak : lean === "with" ? r.streak + 1 : 0;
        return {
          done: r.done + 1,
          agreed: r.agreed + (lean === "with" ? 1 : 0),
          streak: s,
          best: Math.max(r.best, s),
        };
      });
      setBusy(false);
      // The picked portfolio moves to the front (a view transition where the browser has one).
      animated(() => setFocus(side));
      setCounted((c) => c + 1);
      onBadgeCheck();
      // The vote spent this pair: draw the next one now, while the result is
      // on screen, and warm its screenshots and details, so Next is instant.
      const ahead = drawPair();
      upcoming.current = ahead;
      ahead
        .then(({ res: r, data: d }) => {
          if (r.ok && d?.a && d?.b) {
            warm(d.a);
            warm(d.b);
          }
        })
        .catch(() => {
          if (upcoming.current === ahead) upcoming.current = null;
        });
    },
    [pair, busy, pick, finished, reduced, saveRound, load, onBadgeCheck],
  );

  const next = useCallback(() => {
    if (busy) return;
    setNote(null);
    // The last vote ends the round: its summary first, a new pair after.
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
        r
          ? {
              ...r,
              ...(typeof data.anonVotesUsed === "number" ? { anonVotesUsed: data.anonVotesUsed } : {}),
              ...(typeof data.stars === "number" ? { stars: data.stars } : {}),
            }
          : r,
      );
      saveRound((r) => ({
        ...r,
        done: Math.max(0, r.done - 1),
        agreed: Math.max(0, r.agreed - (withCrowd ? 1 : 0)),
        streak: 0,
      }));
      // A vote spends its pair, so the next pick is on a fresh one.
      setNote("Undid your last vote. Here's a fresh pair.");
      load();
    } catch {
      setNote("Undo failed. Try again.");
      setBusy(false);
    }
  }, [pick, busy, pair, load, saveRound]);

  const again = () => {
    saveRound(() => EMPTY_ROUND);
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
      else if (pick !== null && (key === "ArrowRight" || key === "n" || key === "Escape" || (key === "Enter" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement))))
        next();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, vote, next, finished, pair]);

  const shares = pair ? { a: shareOf(pair.a.elo, pair.b.elo), b: shareOf(pair.b.elo, pair.a.elo) } : null;
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
        <ViewControls prefs={prefs} choose={choose} toggle={toggle} />
      </div>

      {intro && guest && (
        <div className="mb-3 flex items-start gap-3 rounded-xl border border-edge bg-raised p-3 text-sm">
          <p className="min-w-0 flex-1">
            <strong>Pick the portfolio you&apos;d rather hire from.</strong> Vote as long as you like. Your votes count on the People board once you{" "}
            <button type="button" onClick={signIn} className="font-semibold text-accent underline underline-offset-2">
              sign in
            </button>
            , whenever suits you.
          </p>
          <button type="button" onClick={dismissIntro} aria-label="Dismiss" className="-m-2 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-mute hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {finished ? (
        <section aria-labelledby="round-done" className="card pop-in grid place-items-center gap-2 px-6 py-12 text-center">
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
            <CopyButton
              text={`I picked with the crowd ${agreed} of ${ROUND} times in PortfolioRank's face-off. Which portfolio would you hire from? ${typeof window === "undefined" ? "" : `${window.location.origin}/play`}`}
              label="Share your result"
              icon={Share2}
              buttonClass={btnSecondary}
            />
            <Link href="/top" className={btnSecondary}>
              <Trophy className="h-4 w-4" aria-hidden /> See the portfolios that did best
            </Link>
          </div>
          {guest && (
            <div className="mt-5 grid max-w-md gap-2 rounded-xl border border-accent/40 bg-accent-soft p-4">
              <p className="text-sm">
                <strong>Sign in to save your votes and badges.</strong> Your votes then count on the People board, and you come back to this page.
              </p>
              <button type="button" onClick={signIn} className={`${btnPrimary} justify-self-center`}>
                Sign in
              </button>
            </div>
          )}
          {games && (
            <a href="/play?mode=guess" className="mt-3 text-sm font-semibold text-accent underline-offset-4 hover:underline">
              Try Guess the percentile
            </a>
          )}
        </section>
      ) : loadError && !pair ? (
        <div role="alert" className="card grid place-items-center gap-2 px-6 py-14 text-center">
          <p className="font-semibold">Couldn&apos;t load a pair.</p>
          <p className="text-sm text-mute">Check your connection and try again.</p>
          <button type="button" onClick={load} className={`${btnPrimary} mt-3`}>
            Retry
          </button>
        </div>
      ) : pair && shares && pick !== null && focus ? (
        // After the vote: the spotlight. The portfolio in focus (first the one
        // picked) moves to the front with its result, ELO and actions; the
        // other waits at the side, and clicking it swaps them. It lives in
        // the page: Next (or Escape) moves on whenever the viewer is ready.
        <div className="grid grid-cols-1 items-start gap-3 sm:gap-5 md:grid-cols-[minmax(0,2.6fr)_minmax(0,1fr)]">
          {(() => {
            const e = pair[focus];
            const mine = pick === focus;
            return (
              <article
                key={`${pair.token}-${focus}`}
                ref={spotlightRef}
                aria-label={`${e.name}, in focus`}
                className={`card relative flex min-w-0 scroll-mt-20 flex-col overflow-hidden ${mine ? "shadow-[0_0_0_3px_var(--color-fill)]" : ""}`}
                style={{ viewTransitionName: `faceoff-card-${focus}` } as React.CSSProperties}
              >
                <NameLine name={e.name} url={e.url} liked={e.liked} onSaved={() => onBadgeCheck()} className="border-b border-edge" />
                <div className="relative">
                  <div className="h-[clamp(160px,30vh,340px)] w-full overflow-hidden">
                    <Frame e={e} />
                  </div>
                  <Share pct={shares[focus]} mine={mine} k={`${pair.token}-${focus}`} />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-edge px-3 py-2.5 sm:px-4">
                  <EloLine url={e.url} />
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className={`${btnSecondary} h-10 px-3`}>
                      <ExternalLink className="h-4 w-4" aria-hidden /> Visit site
                    </a>
                    <a href={`/p/${encodeURIComponent(e.url)}`} target="_blank" rel="noopener" className={`${btnSecondary} h-10 px-3`}>
                      <ArrowUpRight className="h-4 w-4" aria-hidden /> Full profile
                    </a>
                    <ViewControls prefs={prefs} choose={choose} toggle={toggle} />
                  </span>
                </div>
                {simple ? <PlaySummary url={e.url} /> : <DetailsPanel id={`details-${focus}`} url={e.url} record profile={false} metrics={prefs.metrics} sections={prefs.sections} />}
              </article>
            );
          })()}
          {(() => {
            const side: Side = focus === "a" ? "b" : "a";
            const e = pair[side];
            return (
              // The side column stays in view: the other portfolio, then Next.
              <div className="grid gap-3 md:sticky md:top-20">
                {/* Next is always one look away; on a phone the bar at the bottom carries it. */}
                <div className="card grid gap-2 p-3 text-center max-md:hidden">
                  <p className="text-sm" aria-hidden>
                    <span className="font-semibold">{LEAN[leanOf(shares[pick])]}</span> <span className="text-mute">{official ? "Counted." : "Practice vote: it counts once you sign in."}</span>
                  </p>
                  <button ref={nextRef} type="button" onClick={next} disabled={busy} aria-keyshortcuts="Enter N Escape" className={`${btnPrimary} w-full`}>
                    {done >= ROUND ? "See results" : "Next pair"} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={undo}
                    disabled={busy}
                    className="inline-flex min-h-9 items-center justify-center gap-1 px-2 text-xs text-mute transition hover:text-ink disabled:opacity-50"
                  >
                    <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
                  </button>
                </div>
                <button
                  key={`${pair.token}-${side}`}
                  type="button"
                  onClick={() => animated(() => setFocus(side))}
                  aria-label={`Bring ${e.name} to the front`}
                  className="card group relative flex min-w-0 flex-col overflow-hidden text-left transition hover:shadow-[0_0_0_2px_var(--color-edge-strong)]"
                  style={{ viewTransitionName: `faceoff-card-${side}` } as React.CSSProperties}
                >
                  <span className="relative block aspect-[16/10] w-full overflow-hidden">
                    <Frame e={e} />
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2.5 pt-8 text-white">
                      {pick === side && (
                        <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11px] font-bold text-on-fill">
                          <Check className="h-3 w-3" aria-hidden /> Your pick
                        </span>
                      )}
                      <span className="block text-xl font-bold tabular-nums">{shares[side]}%</span>
                      <span className="block text-[11px] text-white/80">would pick this one</span>
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 p-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{e.name}</span>
                      <span className="block truncate text-xs text-mute">{domainOf(e.url)}</span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-accent group-hover:underline">Look closer</span>
                  </span>
                </button>
              </div>
            );
          })()}
        </div>
      ) : pair && shares ? (
        // The screenshots are the hero: side by side from md up, stacked on a
        // phone, short enough that both cards, their details and Pick fit on
        // a 1440x900 or 1920x1080 screen.
        <div className="grid grid-cols-1 items-stretch gap-3 sm:gap-5 md:grid-cols-2">
          {(["a", "b"] as const).map((side) => {
            const e = pair[side];
            return (
              <article
                key={`${pair.token}-${side}`}
                aria-label={e.name}
                className="card deal-in relative flex min-w-0 flex-col overflow-hidden transition-shadow has-[.pick:hover]:shadow-[0_0_0_2px_var(--color-fill),0_0_28px_-6px_var(--color-fill)] has-[.pick:focus-visible]:shadow-[0_0_0_2px_var(--color-fill),0_0_28px_-6px_var(--color-fill)]"
                // The card's view-transition name lets it ease to its new size when the view changes or the spotlight opens.
                style={{ "--d": `${side === "a" ? 0 : 90}ms`, viewTransitionName: `faceoff-card-${side}` } as React.CSSProperties}
              >
                <NameLine name={e.name} url={e.url} liked={e.liked} onSaved={() => onBadgeCheck()} className="border-b border-edge" />
                {/* The screenshot across the card, then Simple's strip or the chosen details under it. */}
                <div className="flex-1">
                  <button
                    type="button"
                    onClick={() => vote(side)}
                    disabled={busy}
                    tabIndex={-1}
                    aria-hidden
                    className="pick group relative block aspect-[16/9] w-full cursor-pointer overflow-hidden text-left outline-none disabled:cursor-default md:aspect-auto md:h-[clamp(150px,25vh,290px)]"
                  >
                    <Frame e={e} />
                    <span className="pointer-events-none absolute inset-0 bg-black/0 transition group-hover:bg-black/10" />
                    {/* Always visible, so it's clear the screenshot picks (no hover needed, touch too). */}
                    <span className="pointer-events-none absolute bottom-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-white shadow-lg backdrop-blur transition group-hover:bg-fill group-hover:text-on-fill">
                      <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
                      <span className="pointer-coarse:hidden">Click to pick</span>
                      <span className="hidden pointer-coarse:inline">Tap to pick</span>
                    </span>
                  </button>
                  {simple ? <PlaySummary url={e.url} /> : <DetailsPanel id={`details-${side}`} url={e.url} record={false} profile={false} metrics={prefs.metrics} sections={prefs.sections} />}
                </div>
                {/* The pick, centered under its card. */}
                <div className="flex items-center justify-center border-t border-edge p-2">
                  <button
                    type="button"
                    onClick={() => vote(side)}
                    disabled={busy}
                    aria-label={`Pick ${e.name}`}
                    aria-keyshortcuts={side === "a" ? "ArrowLeft" : "ArrowRight"}
                    className={`${btnPrimary} pick min-w-48`}
                  >
                    <Check className="h-4 w-4" aria-hidden /> Pick {e.name.split(" ")[0]}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        // Skeleton in the cards' own shape, so nothing jumps when the pair arrives.
        <div className="grid grid-cols-1 gap-3 sm:gap-5 md:grid-cols-2" aria-busy="true">
          {[0, 1].map((k) => (
            <div key={k} aria-hidden className="card overflow-hidden">
              <div className="flex h-[3.75rem] items-center border-b border-edge px-3 sm:px-4">
                <div className="h-4 w-2/5 rounded bg-raised motion-safe:animate-pulse" />
              </div>
              <div className="aspect-[16/9] w-full bg-raised motion-safe:animate-pulse md:aspect-[16/10]" />
              <div className="grid gap-2 border-t border-edge p-3 sm:p-4">
                <div className="h-4 w-1/3 rounded bg-raised motion-safe:animate-pulse" />
                <div className="h-10 rounded-lg bg-raised motion-safe:animate-pulse" />
              </div>
              <div className="h-[4.1rem] border-t border-edge sm:h-[4.35rem]" />
            </div>
          ))}
        </div>
      )}

      {/* Results, errors and loading, announced without moving focus. */}
      <p role="status" aria-live="polite" className="sr-only">
        {busy && !pair ? "Loading a pair" : pick && pair && shares ? `You picked ${pair[pick].name}. ${shares[pick]}% of people would pick it. ${LEAN[leanOf(shares[pick])]}` : (note ?? "")}
      </p>

      {/* Right under the cards, centered where the eye already is; on a phone it stays above the tab bar. */}
      {!finished && (pair || loadError) && (
        <div
          className={`${pick !== null && focus ? "md:hidden" : ""} max-md:sticky max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 mt-3 flex min-h-14 flex-col items-center justify-center gap-1 text-center max-md:-mx-1 max-md:rounded-2xl max-md:border max-md:border-edge max-md:bg-card/92 max-md:p-2 max-md:shadow-[var(--card-hi),var(--card-drop)] max-md:backdrop-blur`}
        >
          {pick === null ? (
            <>
              <p className="text-sm text-mute">
                {note ? (
                  <span className="font-medium text-accent">{note}</span>
                ) : (
                  <>
                    <span className="md:hidden">Tap the one you&apos;d hire from.</span>
                    <span className="max-md:hidden">
                      Click the one you&apos;d hire from, or press <kbd className={kbd}>←</kbd> <kbd className={kbd}>→</kbd>
                    </span>
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={next}
                disabled={busy}
                aria-keyshortcuts="S"
                className="min-h-9 px-2 text-xs text-mute underline decoration-edge-strong underline-offset-4 transition hover:text-ink disabled:opacity-50"
              >
                Can&apos;t decide, skip
              </button>
            </>
          ) : (
            <>
              <p className="pop-in text-sm" aria-hidden>
                <span className="font-semibold">{shares && LEAN[leanOf(shares[pick])]}</span> <span className="text-mute">{official ? "Counted." : "Practice vote: it counts once you sign in."}</span>
              </p>
              <div className="flex items-center gap-3">
                <button type="button" onClick={next} disabled={busy} aria-keyshortcuts="Enter N ArrowRight" className={`${btnPrimary} min-w-44 whitespace-nowrap`}>
                  {done >= ROUND ? "See results" : "Next pair"} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                  <kbd className="hidden rounded border border-on-fill/30 px-1 text-[11px] md:inline">Enter</kbd>
                </button>
                <button type="button" onClick={undo} disabled={busy} className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-mute transition hover:text-ink disabled:opacity-50">
                  <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
