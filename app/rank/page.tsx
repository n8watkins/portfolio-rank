"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InspectChips } from "@/components/Diagnostics";
import { SignInModal } from "@/components/SignInModal";
import { AuthButton } from "@/components/AuthButton";

type Entry = {
  name: string;
  url: string;
  tagline?: string;
  elo: number;
  votes: number;
  shot?: string | null;
};

type RaterInfo = {
  signedIn: boolean;
  login: string | null;
  anonVotesUsed: number | null;
  anonVoteLimit: number;
  stars: number;
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Prefers our own Playwright captures (`shot` = capture base dir): the mobile
// frame on phones, the desktop hero above. Falls back to mShots when we have no
// capture (slow, placeholder-while-generating → retry until the real shot loads).
const SHOT_CLASS = "aspect-[4/3] w-full bg-edge object-cover object-top";

function Shot({ url, shot }: { url: string; shot?: string | null }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);

  if (shot && !failed) {
    return (
      <picture>
        <source media="(max-width: 639px)" srcSet={`${shot}/mobile.jpg`} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${shot}/hero.jpg`}
          alt={`Screenshot of ${domainOf(url)}`}
          className={SHOT_CLASS}
          onError={() => setFailed(true)}
        />
      </picture>
    );
  }

  const src = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(
    url
  )}?w=900&vpw=1440&vph=900${tick ? `&retry=${tick}` : ""}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`Screenshot of ${domainOf(url)}`}
      className={SHOT_CLASS}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth < 700 && tick < 6) {
          setTimeout(() => setTick((t) => t + 1), 2500);
        }
      }}
    />
  );
}

export default function RankPage() {
  const [pair, setPair] = useState<{ a: Entry; b: Entry } | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<"a" | "b" | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const [autoOpen, setAutoOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const [rater, setRater] = useState<RaterInfo | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const nudgedRef = useRef(false);
  const firstPairRef = useRef(true);
  const autoOpenRef = useRef(autoOpen);
  autoOpenRef.current = autoOpen;
  const pairRef = useRef(pair);
  pairRef.current = pair;

  const gated =
    rater !== null &&
    !rater.signedIn &&
    (rater.anonVotesUsed ?? 0) >= rater.anonVoteLimit;

  const loadPair = useCallback(async () => {
    const res = await fetch("/api/rank");
    const data = await res.json();
    setPair({ a: data.a, b: data.b });
    // Auto-open both sites for the NEW pair so you can review them before voting.
    // Skipped on the very first load (no user gesture → browsers block popups).
    if (autoOpenRef.current && !firstPairRef.current) {
      window.open(data.a.url, "_blank", "noopener");
      window.open(data.b.url, "_blank", "noopener");
    }
    firstPairRef.current = false;
    if (data.rater) {
      setRater(data.rater);
      if (
        !data.rater.signedIn &&
        (data.rater.anonVotesUsed ?? 0) === 0 &&
        !nudgedRef.current &&
        !sessionStorage.getItem("pr_signin_nudged")
      ) {
        nudgedRef.current = true;
        sessionStorage.setItem("pr_signin_nudged", "1");
        setSignInOpen(true);
      }
    }
    setPicked(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    loadPair();
  }, [loadPair]);

  useEffect(() => {
    setAutoOpen(localStorage.getItem("pr_autoopen") === "1");
  }, []);

  const vote = useCallback(
    async (side: "a" | "b", star = false) => {
      const p = pairRef.current;
      if (!p || busy || gated || picked) return;
      setBusy(true);
      setPicked(side); // instant feedback — winner highlights, loser recedes
      const winner = p[side];
      const loser = p[side === "a" ? "b" : "a"];

      let res: Response;
      let data: {
        error?: string;
        official?: boolean;
        delta?: number;
        winnerElo?: number;
        anonVotesUsed?: number;
        starred?: boolean;
        stars?: number;
      };
      try {
        res = await fetch("/api/rank", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ winner: winner.url, loser: loser.url, star }),
        });
        data = await res.json();
      } catch {
        setLast("Vote failed — try again.");
        setPicked(null);
        setBusy(false);
        return;
      }

      if (res.status === 403 && data.error === "signin_required") {
        setRater((r) => (r ? { ...r, anonVotesUsed: r.anonVoteLimit } : r));
        setSignInOpen(true);
        setPicked(null);
        setBusy(false);
        return;
      }
      if (res.status === 409) {
        setLast("You already voted on this pair — here's a fresh one.");
        loadPair();
        return;
      }
      if (res.status === 429) {
        setLast(
          data.error === "too_fast"
            ? "Easy there — give each pair a real look before voting."
            : "Daily vote limit reached — come back tomorrow!"
        );
        setPicked(null);
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setLast("Vote failed — try again.");
        setPicked(null);
        setBusy(false);
        return;
      }

      setLast(
        data.starred
          ? `⭐ Super-voted ${winner.name}! +${data.delta} → ${data.winnerElo} ELO`
          : data.official
            ? `${winner.name} wins · +${data.delta} → ${data.winnerElo} ELO`
            : `${winner.name} wins · practice vote (+${data.delta} if official)`
      );
      const av = data.anonVotesUsed;
      if (typeof av === "number") {
        setRater((r) => (r ? { ...r, anonVotesUsed: av } : r));
      }
      const st = data.stars;
      if (typeof st === "number") {
        setRater((r) => (r ? { ...r, stars: st } : r));
      }
      setCount((c) => c + 1);
      // Let the "you picked this" animation play before the next pair slides in.
      await new Promise((r) => setTimeout(r, 480));
      loadPair();
    },
    [busy, gated, picked, loadPair]
  );

  const skip = useCallback(() => {
    if (busy || picked) return;
    setBusy(true);
    setLast(null);
    loadPair();
  }, [busy, picked, loadPair]);

  const undo = useCallback(async () => {
    if (busy || picked || count === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/rank/undo", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setCount((c) => Math.max(0, c - 1));
        if (typeof data.anonVotesUsed === "number") {
          setRater((r) => (r ? { ...r, anonVotesUsed: data.anonVotesUsed } : r));
        }
        if (typeof data.stars === "number") {
          setRater((r) => (r ? { ...r, stars: data.stars } : r));
        }
        setLast("↩ Undid your last vote.");
      } else {
        setLast("Nothing to undo.");
      }
    } catch {
      setLast("Undo failed — try again.");
    }
    setBusy(false);
  }, [busy, picked, count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") vote("a");
      else if (e.key === "ArrowRight") vote("b");
      else if (e.key === "ArrowDown" || e.key === "s") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vote, skip]);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        title={gated ? "You're out of practice votes" : "Make your votes count"}
        body={
          gated
            ? "Sign in to keep voting — your practice votes convert into official ones."
            : "Sign in so your picks move the official rankings. Or skip and try 10 practice votes first — they convert when you sign in."
        }
        skipLabel={gated ? "Not now" : "Skip — try practice votes first"}
      />
      <header className="flex items-center justify-between gap-3 py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-mute sm:block">
            {count} vote{count === 1 ? "" : "s"} this session
          </p>
          <AuthButton />
        </div>
      </header>

      <div className="py-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Which portfolio is better?
        </h1>
        <p className="mt-2 text-sm text-mute">
          <span className="hidden sm:inline">
            Click a screenshot to pick it, or use ← → keys. ↓ to skip.
          </span>
          <span className="sm:hidden">
            Tap a screenshot to pick it — or Skip below if you can&apos;t tell.
          </span>
        </p>
        {last && <p className="mt-2 text-sm font-medium text-accent">{last}</p>}
        {rater && !rater.signedIn && !gated && (
          <p className="mt-2 text-xs text-mute">
            Practice mode — {rater.anonVotesUsed ?? 0}/{rater.anonVoteLimit}{" "}
            free votes used.{" "}
            <button
              onClick={() => setSignInOpen(true)}
              className="font-semibold text-accent underline underline-offset-2"
            >
              Sign in
            </button>{" "}
            and your practice votes become official.
          </p>
        )}
        {rater?.signedIn && (
          <p className="mt-2 text-xs text-mute">
            Voting as <span className="font-semibold">{rater.login}</span> —
            your votes count toward official rankings.
          </p>
        )}
        {rater?.signedIn && rater.stars > 0 && (
          <p className="mt-1 text-xs font-medium text-accent">
            ⭐ {rater.stars} Superstar{rater.stars === 1 ? "" : "s"} to spend —
            tap ⭐ on a standout to super-vote it (double weight + Most Loved).
          </p>
        )}
      </div>

      {gated && (
        <div className="mx-auto mb-6 max-w-md rounded-xl border border-accent/40 bg-card p-6 text-center">
          <p className="text-lg font-bold">You&apos;re out of practice votes</p>
          <p className="mt-2 text-sm text-mute">
            Sign in to keep voting — your {rater?.anonVoteLimit} practice votes
            convert into official ones, and everything after counts too.
          </p>
          <button
            onClick={() => setSignInOpen(true)}
            className="mt-4 inline-block rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-bg transition hover:opacity-85"
          >
            Sign in
          </button>
        </div>
      )}

      {pair ? (
        <div className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2">
          {(["a", "b"] as const).map((side) => {
            const p = pair[side];
            const isWinner = picked === side;
            const isLoser = picked !== null && picked !== side;
            return (
              <div
                key={p.url}
                className={`fade-up overflow-hidden rounded-xl border bg-card transition-all duration-500 ${
                  isWinner
                    ? "z-10 scale-[1.03] border-accent ring-2 ring-accent"
                    : isLoser
                      ? "scale-95 border-edge opacity-40"
                      : "border-edge"
                }`}
              >
                {/* The screenshot is the only vote target. */}
                <div className="relative">
                  <button
                    onClick={() => vote(side)}
                    disabled={busy || gated || picked !== null}
                    aria-label={`Pick ${p.name}`}
                    className="group relative block w-full disabled:cursor-default"
                  >
                    <Shot url={p.url} shot={p.shot} />
                    {!picked && (
                      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-bg/85 to-transparent py-4 text-sm font-bold text-ink opacity-0 transition group-hover:opacity-100">
                        ✓ Pick this one
                      </span>
                    )}
                    {isWinner && (
                      <span className="absolute right-2 top-2 rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-bg shadow">
                        ✓ Your pick
                      </span>
                    )}
                  </button>
                  {rater?.signedIn && rater.stars > 0 && !picked && (
                    <button
                      onClick={() => vote(side, true)}
                      disabled={busy || picked !== null}
                      title="Super-vote: spend a ⭐ for double ELO weight + a Most-Loved star"
                      className="absolute left-2 top-2 z-10 rounded-full bg-bg/80 px-2.5 py-1 text-xs font-bold text-accent backdrop-blur transition hover:bg-accent hover:text-bg"
                    >
                      ⭐ Super
                    </button>
                  )}
                </div>

                {/* Metadata — deliberately OUTSIDE the vote target. */}
                <div className="flex items-start justify-between gap-2 p-4 pb-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{p.name}</p>
                    <p className="truncate text-sm text-mute">
                      {p.tagline ?? domainOf(p.url)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <p className="text-sm font-semibold tabular-nums">{p.elo}</p>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-mute underline decoration-edge underline-offset-2 transition hover:text-ink"
                    >
                      visit ↗
                    </a>
                    <a
                      href={`/p/${encodeURIComponent(p.url)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-mute underline decoration-edge underline-offset-2 transition hover:text-ink"
                    >
                      details
                    </a>
                  </div>
                </div>

                {/* Diagnostics — desktop only, behind the toggle. */}
                {showDetails && (
                  <div className="hidden px-4 pb-3 sm:block">
                    <InspectChips url={p.url} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="py-24 text-center text-sm text-mute">Loading pair…</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3 pb-12">
        <button
          onClick={() => {
            const p = pairRef.current;
            if (!p) return;
            window.open(p.a.url, "_blank", "noopener");
            window.open(p.b.url, "_blank", "noopener");
          }}
          className="rounded-lg border border-edge px-5 py-2 text-sm font-semibold transition hover:border-mute"
          title="If only one opens, allow pop-ups for this site"
        >
          Open both sites ↗↗
        </button>
        <button
          onClick={skip}
          disabled={busy || picked !== null}
          className="rounded-lg border border-edge px-5 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink disabled:opacity-60"
        >
          Skip — can&apos;t tell ↓
        </button>
        <button
          onClick={undo}
          disabled={busy || picked !== null || count === 0}
          className="rounded-lg border border-edge px-5 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink disabled:opacity-40"
          title="Undo your last vote (reverts its ELO)"
        >
          ↩ Undo
        </button>
        <button
          onClick={() => setShowDetails((s) => !s)}
          className="hidden rounded-lg border border-edge px-5 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink sm:inline-flex"
        >
          {showDetails ? "Hide details" : "Show details"}
        </button>
        <button
          onClick={() =>
            setAutoOpen((v) => {
              const nv = !v;
              localStorage.setItem("pr_autoopen", nv ? "1" : "0");
              return nv;
            })
          }
          title="Open both sites in new tabs automatically when you vote"
          className={`rounded-lg border px-5 py-2 text-sm font-semibold transition ${
            autoOpen
              ? "border-accent text-accent"
              : "border-edge text-mute hover:border-mute hover:text-ink"
          }`}
        >
          Auto-open: {autoOpen ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}
