"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InspectChips } from "@/components/Diagnostics";
import { SignInModal } from "@/components/SignInModal";

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
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Prefers our own Playwright capture (`shot`, from R2); falls back to the
// free mShots service, which serves a placeholder while it generates, so
// retry until the real shot (full width) arrives.
function Shot({ url, shot }: { url: string; shot?: string | null }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const useOwn = shot && !failed;
  const src = useOwn
    ? shot
    : `https://s.wordpress.com/mshots/v1/${encodeURIComponent(
        url
      )}?w=900&vpw=1440&vph=900${tick ? `&retry=${tick}` : ""}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`Screenshot of ${domainOf(url)}`}
      className="aspect-[4/3] w-full rounded-t-xl bg-edge object-cover object-top"
      onError={() => useOwn && setFailed(true)}
      onLoad={(e) => {
        if (useOwn) return;
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
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const [rater, setRater] = useState<RaterInfo | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const nudgedRef = useRef(false);
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
    if (data.rater) {
      setRater(data.rater);
      // One-time nudge per tab session: invite first-time anon visitors to
      // sign in up front, with an easy skip into practice mode.
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
    setBusy(false);
  }, []);

  useEffect(() => {
    loadPair();
  }, [loadPair]);

  const vote = useCallback(
    async (side: "a" | "b") => {
      const p = pairRef.current;
      if (!p || busy || gated) return;
      setBusy(true);
      const winner = p[side];
      const loser = p[side === "a" ? "b" : "a"];
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winner: winner.url, loser: loser.url }),
      });
      const data = await res.json();

      if (res.status === 403 && data.error === "signin_required") {
        setRater((r) =>
          r ? { ...r, anonVotesUsed: r.anonVoteLimit } : r
        );
        setSignInOpen(true);
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
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setLast("Vote failed — try again.");
        setBusy(false);
        return;
      }

      setLast(
        data.official
          ? `${winner.name} wins · +${data.delta} → ${data.winnerElo} ELO`
          : `${winner.name} wins · practice vote (+${data.delta} if official)`
      );
      if (typeof data.anonVotesUsed === "number") {
        setRater((r) => (r ? { ...r, anonVotesUsed: data.anonVotesUsed } : r));
      }
      setCount((c) => c + 1);
      loadPair();
    },
    [busy, gated, loadPair]
  );

  const skip = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setLast(null);
    loadPair();
  }, [busy, loadPair]);

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
      <header className="flex items-center justify-between py-4">
        <a href="/" className="text-sm font-bold tracking-tight">
          ← Portfolio<span className="text-accent">Rank</span>
        </a>
        <p className="text-xs text-mute">
          {count} vote{count === 1 ? "" : "s"} this session
        </p>
      </header>

      <div className="py-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Which portfolio is better?
        </h1>
        <p className="mt-2 text-sm text-mute">
          Click one, or use ← → keys. ↓ to skip.
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
            return (
              <button
                key={p.url}
                onClick={() => vote(side)}
                disabled={busy || gated}
                className="group rounded-xl border border-edge bg-card text-left transition duration-200 hover:-translate-y-1 hover:border-accent disabled:opacity-60"
              >
                <Shot url={p.url} shot={p.shot} />
                <div className="flex items-start justify-between gap-2 p-4 pb-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{p.name}</p>
                    <p className="truncate text-sm text-mute">
                      {p.tagline ?? domainOf(p.url)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <p className="text-sm font-semibold tabular-nums">
                      {p.elo}
                    </p>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-mute underline decoration-edge underline-offset-2 transition hover:text-ink"
                    >
                      visit ↗
                    </a>
                    <a
                      href={`/p/${encodeURIComponent(p.url)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-mute underline decoration-edge underline-offset-2 transition hover:text-ink"
                    >
                      details
                    </a>
                  </div>
                </div>
                <div className="px-4 pb-3">
                  <InspectChips url={p.url} />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="py-24 text-center text-sm text-mute">Loading pair…</p>
      )}

      <div className="flex items-center justify-center gap-3 pb-12">
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
          disabled={busy}
          className="rounded-lg border border-edge px-5 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink disabled:opacity-60"
        >
          Skip — can&apos;t tell ↓
        </button>
      </div>
    </div>
  );
}
