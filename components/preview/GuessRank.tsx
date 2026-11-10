"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Flame, Merge, Target, Trophy, Users } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { isTextField } from "@/lib/dom";
import { useCountUp } from "@/components/preview/useCountUp";

export type Round = {
  name: string;
  domain: string;
  shot: string;
  slug: string;
  tagline?: string;
  merged: number;
  ai: number;
  people: number;
  tier: string;
};

const QUICK = [
  { label: "Top 10", rank: 5 },
  { label: "Top 50", rank: 30 },
  { label: "Top 100", rank: 75 },
  { label: "Top 250", rank: 175 },
  { label: "250+", rank: 420 },
];

/** Slider position (0-1000) to rank, on a log scale so the top gets room. */
const toRank = (pos: number, total: number) => Math.max(1, Math.round(Math.exp((pos / 1000) * Math.log(total))));
const toPos = (rank: number, total: number) => Math.round((Math.log(rank) / Math.log(total)) * 1000);

/** 100 for exact, 0 when off by 4x or more. */
function points(guess: number, actual: number) {
  const off = Math.abs(Math.log(guess) - Math.log(actual));
  return Math.max(0, Math.round(100 * (1 - off / Math.log(4))));
}

function verdict(p: number) {
  if (p >= 90) return "Spot on";
  if (p >= 65) return "Close";
  if (p >= 35) return "In the area";
  return "Way off";
}

/** Guess the rank: see one portfolio, guess its merged rank, then reveal all three views. */
export function GuessRank({ rounds, total, reveal = false }: { rounds: Round[]; total: number; reveal?: boolean }) {
  const [i, setI] = useState(0);
  // ?reveal=1 (screenshots) opens on a near-miss result.
  const [pos, setPos] = useState(reveal ? toPos(Math.round(rounds[0].merged * 1.4) + 1, total) : toPos(100, total));
  const [shown, setShown] = useState(reveal);
  const [score, setScore] = useState(reveal ? 142 : 0);
  const [streak, setStreak] = useState(reveal ? 2 : 0);
  const [best, setBest] = useState(reveal ? 3 : 0);
  const r = rounds[i % rounds.length];
  const guess = toRank(pos, total);
  const p = useMemo(() => points(guess, r.merged), [guess, r.merged]);

  const submit = () => {
    if (shown) return;
    setShown(true);
    setScore((s) => s + p);
    const close = p >= 65;
    setStreak((s) => {
      const n = close ? s + 1 : 0;
      setBest((b) => Math.max(b, n));
      return n;
    });
  };
  const next = () => {
    setShown(false);
    setI((n) => n + 1);
    setPos(toPos(100, total));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || isModalOpen()) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (shown) next();
        else submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const views = [
    { label: "Merged", Icon: Merge, rank: r.merged },
    { label: "AI", Icon: Bot, rank: r.ai },
    { label: "People", Icon: Users, rank: r.people },
  ];
  const off = Math.abs(guess - r.merged);

  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5">
      <ol className="flex gap-1" aria-label={`Round ${(i % rounds.length) + 1} of ${rounds.length}`}>
        {rounds.map((_, k) => (
          <li
            key={k}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              k < i % rounds.length || (k === i % rounds.length && shown) ? "bg-fill" : k === i % rounds.length ? "bg-edge-strong" : "bg-edge"
            }`}
          />
        ))}
      </ol>
      {/* Scoreboard */}
      <dl className="grid grid-cols-4 gap-2 sm:gap-3">
        {[
          { label: "Round", value: `${(i % rounds.length) + 1}/${rounds.length}`, Icon: Target },
          { label: "Score", value: score, Icon: Trophy },
          { label: "Streak", value: streak, Icon: Flame },
          { label: "Best", value: best, Icon: Flame },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="card px-3 py-2.5 sm:px-4">
            <dt className="flex items-center gap-1.5 text-xs text-mute">
              <Icon className={`h-3.5 w-3.5 ${label === "Streak" && streak > 1 ? "text-accent" : ""}`} aria-hidden /> {label}
            </dt>
            <dd key={label === "Score" ? String(value) : label} className={`mt-0.5 text-lg font-bold tabular-nums sm:text-xl ${label === "Score" && shown ? "pop-in" : ""}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* The portfolio */}
        <figure key={i} className="card pop-in flex flex-col overflow-hidden">
          <div className="relative aspect-[390/290] w-full md:aspect-[16/10]">
            <picture>
              <source media="(max-width: 767px)" srcSet={`${r.shot}/mobile.jpg`} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${r.shot}/hero.jpg`} alt={`Screenshot of ${r.domain}`} className="absolute inset-0 h-full w-full bg-raised object-cover object-top" />
            </picture>
          </div>
          <figcaption className="flex items-center justify-between gap-3 border-t border-edge px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate font-semibold">{r.name}</span>
              <span className="block truncate text-sm text-mute">{r.tagline ?? r.domain}</span>
            </span>
            <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-sm font-semibold text-mute hover:text-ink">
              Open site
            </a>
          </figcaption>
        </figure>

        {/* Guess, then reveal */}
        <section aria-label={shown ? "Result" : "Your guess"} className="card flex flex-col p-5 sm:p-6">
          {!shown ? (
            <>
              <h2 className="text-lg font-bold tracking-tight">Where does it rank?</h2>
              <p className="mt-1 text-sm text-mute">Guess its place on the merged leaderboard, out of {total}.</p>
              <p className="mt-5 text-center">
                <span className="text-xs uppercase tracking-wider text-mute">Your guess</span>
                <span className="block text-5xl font-bold tabular-nums tracking-tight" aria-live="polite">
                  #{guess}
                </span>
              </p>
              <label htmlFor="guess" className="sr-only">
                Your guess, rank 1 to {total}
              </label>
              <input
                id="guess"
                type="range"
                min={0}
                max={1000}
                value={pos}
                onChange={(e) => setPos(Number(e.target.value))}
                aria-valuetext={`Rank ${guess}`}
                className="mt-4 h-2 w-full cursor-pointer accent-[var(--color-fill)]"
              />
              <div className="relative mt-1 h-4 text-xs text-mute tabular-nums" aria-hidden>
                {[1, 10, 100, total].map((t, k, all) => (
                  <span
                    key={t}
                    className="absolute top-0"
                    style={{ left: toPos(t, total) / 10 + "%", translate: k === 0 ? "0" : k === all.length - 1 ? "-100%" : "-50%" }}
                  >
                    #{t}
                  </span>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-5 gap-1.5">
                {QUICK.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => setPos(toPos(q.rank, total))}
                    className="card-hover h-10 whitespace-nowrap rounded-lg border border-edge bg-card px-1 text-xs font-semibold"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={submit} className="group btn-sheen mt-auto inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-fill text-[15px] font-semibold text-on-fill max-lg:mt-5">
                <Target className="icon-twinkle h-4 w-4" aria-hidden /> Lock in #{guess}
              </button>
              <p className="mt-2 text-center text-xs text-mute">Enter locks in. Closer guesses score more, up to 100.</p>
            </>
          ) : (
            <>
              <p role="status" className="pop-in flex items-baseline justify-between gap-3">
                <span className="text-xl font-bold tracking-tight">{verdict(p)}</span>
                <span className="text-sm tabular-nums">
                  <Points value={p} k={i} /> <span className="text-mute">points</span>
                </span>
              </p>
              <Meter guess={guess} actual={r.merged} total={total} />
              <p className="mt-1 text-sm text-mute">
                You guessed #{guess}; it&apos;s #{r.merged} merged. {off === 0 ? "Exactly right." : `Off by ${off} ${off === 1 ? "place" : "places"}.`}
              </p>
              <ul className="mt-4 grid grid-cols-3 gap-2">
                {views.map(({ label, Icon, rank }) => (
                  <li key={label} className="rounded-xl border border-edge bg-bg/40 px-3 py-2.5">
                    <span className="flex items-center gap-1.5 text-xs text-mute">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                    </span>
                    <span className="mt-0.5 block text-xl font-bold tabular-nums">#{rank}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">
                {Math.abs(r.ai - r.people) > total * 0.12
                  ? `AI and people disagree on this one: #${r.ai} vs #${r.people}.`
                  : `AI and people roughly agree: #${r.ai} vs #${r.people}.`}{" "}
                <span className="text-mute">AI tier {r.tier}.</span>
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-sm text-mute">
                <Flame className={`h-4 w-4 ${streak > 0 ? "text-accent" : ""}`} aria-hidden />
                {streak > 0 ? `Streak of ${streak} close guesses.` : "Streak reset. Get within 2x to build one."}
              </p>
              <div className="mt-auto flex gap-2 pt-5">
                <button type="button" onClick={next} autoFocus={!reveal} className="group btn-sheen inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-fill text-[15px] font-semibold text-on-fill">
                  Next portfolio <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </button>
                <a href={`/grade/${r.slug}`} className="inline-flex h-12 items-center rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
                  Report
                </a>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Points({ value, k }: { value: number; k: number }) {
  const n = useCountUp(value, k, 900);
  return <strong className="text-2xl">+{n}</strong>;
}

/** Your guess and the real rank on the same scale as the slider, both labelled. */
function Meter({ guess, actual, total }: { guess: number; actual: number; total: number }) {
  const g = toPos(guess, total) / 10;
  const a = toPos(actual, total) / 10;
  const lo = Math.min(g, a);
  const hi = Math.max(g, a);
  const close = Math.abs(a - g) < 16;
  const clamp = (v: number) => Math.min(90, Math.max(10, v));
  return (
    <div className="mt-5 rounded-xl border border-edge bg-bg/40 px-4 pb-3 pt-4" aria-hidden>
      <div className="relative h-5 text-[11px] font-semibold tabular-nums">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-accent" style={{ left: `${clamp(a)}%` }}>
          real #{actual}
        </span>
      </div>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-edge" />
        <div className="bar-fill absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/45" style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%` }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-mute" style={{ left: `${g}%` }} />
        <span className="pop-in absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-fill shadow" style={{ left: `${a}%` }} />
      </div>
      <div className="relative h-5 text-[11px] tabular-nums text-mute">
        <span className="absolute left-0">#1</span>
        <span className="absolute right-0">#{total}</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap font-semibold text-ink" style={{ left: `${clamp(g)}%` }}>
          {close ? "" : "you "}#{guess}
        </span>
      </div>
    </div>
  );
}
