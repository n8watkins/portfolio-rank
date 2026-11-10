"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Flame, RotateCcw, SkipForward, Target, Undo2, Users, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { isTextField } from "@/lib/dom";
import { useCountUp } from "@/components/preview/useCountUp";
import { SiteActions } from "@/components/preview/SiteActions";
import { Details } from "@/components/preview/Details";
import { Burst } from "@/components/preview/Burst";
import type { Scorecard } from "@/lib/preview/data";

export type Entry = { name: string; domain: string; url: string; shot: string; tagline?: string; slug: string; card: Scorecard };

const ROUND = 10;

function Frame({ e, eager }: { e: Entry; eager: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="grid h-full w-full grid-cols-1 place-items-center bg-raised p-3 text-center text-xs text-mute">{e.domain}</div>;
  return (
    <picture>
      <source media="(max-width: 767px)" srcSet={`${e.shot}/mobile.jpg`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${e.shot}/hero.jpg`}
        alt={`Screenshot of ${e.domain}`}
        loading={eager ? "eager" : "lazy"}
        onError={() => setFailed(true)}
        className="h-full w-full bg-raised object-cover object-top"
      />
    </picture>
  );
}

/** The crowd's share on a card after the vote: counts up, bar fills. */
function Share({ pct, mine, k }: { pct: number; mine: boolean; k: string }) {
  const n = useCountUp(pct, k);
  return (
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 pt-12 text-white sm:p-4">
      {mine && (
        <Burst on>
          <span className="pop-in mb-2 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-xs font-bold text-on-fill">
            <Check className="h-3 w-3" aria-hidden /> Your pick
          </span>
        </Burst>
      )}
      <p className="text-3xl font-bold tabular-nums sm:text-4xl">{n}%</p>
      <p className="text-xs text-white/80">of people picked this</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20" aria-hidden>
        <div className={`bar-fill h-full rounded-full ${mine ? "bg-fill" : "bg-white/70"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Two portfolios, pick one; the crowd's split shows on the cards themselves. */
export function FaceOff({ pairs, voted, details }: { pairs: [Entry, Entry][]; voted: boolean; details?: "simple" | "advanced" }) {
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<0 | 1 | null>(null);
  const [intro, setIntro] = useState(!voted);
  const [done, setDone] = useState(0); // votes this round
  const [agreed, setAgreed] = useState(0);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  // Off by default so votes stay honest; remembered in this browser.
  const [showScores, setShowScores] = useState(false);
  useEffect(() => {
    try {
      setShowScores(localStorage.getItem("pr-show-scores") === "1");
    } catch {}
  }, []);
  const pair = pairs[i % pairs.length];
  // Sample share of people who picked the left one.
  const leftPct = 35 + ((i * 29) % 40);
  const pct = [leftPct, 100 - leftPct];
  const finished = done >= ROUND && pick === null;

  const vote = useCallback(
    (side: 0 | 1) => {
      if (pick !== null || finished) return;
      setPick(side);
      // A tiny haptic tick on phones that support it.
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) navigator.vibrate?.(12);
      setDone((d) => d + 1);
      setIntro(false);
      const withCrowd = pct[side] >= 50;
      if (withCrowd) setAgreed((a) => a + 1);
      setStreak((s) => {
        const n = withCrowd ? s + 1 : 0;
        setBest((b) => Math.max(b, n));
        return n;
      });
    },
    [pick, finished, pct]
  );
  const next = useCallback(() => {
    setPick(null);
    setI((n) => n + 1);
  }, []);
  const again = () => {
    setDone(0);
    setAgreed(0);
    setStreak(0);
    setPick(null);
    setI((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || isModalOpen() || e.metaKey || e.ctrlKey || e.altKey || finished) return;
      if (pick === null && e.key === "ArrowLeft") vote(0);
      else if (pick === null && e.key === "ArrowRight") vote(1);
      else if (e.key === "s" || e.key === "S" || (pick !== null && (e.key === "Enter" || e.key === "ArrowRight"))) {
        e.preventDefault();
        next();
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, vote, next, finished]);

  return (
    <div>
      {/* Progress through the round */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {Math.min(done, ROUND)} / {ROUND}
          </span>
          <ol className="flex flex-1 gap-1" aria-label={`Vote ${Math.min(done, ROUND)} of ${ROUND}`}>
            {Array.from({ length: ROUND }, (_, k) => (
              <li key={k} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${k < done ? "bg-fill" : "bg-edge"}`} />
            ))}
          </ol>
        </div>
        <span className="flex items-center gap-4 text-sm text-mute">
          <span className="flex items-center gap-1.5" title="Picked the same as most people">
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

      {intro && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3.5 text-sm">
          <p className="min-w-0 flex-1">
            <strong>Pick the portfolio you&apos;d rather hire from.</strong> Your first 10 votes are practice: you see how others voted, and they count once you sign in.
          </p>
          <button type="button" onClick={() => setIntro(false)} aria-label="Dismiss" className="-m-2 grid h-10 w-10 shrink-0 grid-cols-1 place-items-center rounded-lg text-mute hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {finished ? (
        <section aria-labelledby="round-done" className="card pop-in grid grid-cols-1 place-items-center gap-2 px-6 py-14 text-center">
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
            <button type="button" onClick={again} className="group btn-sheen inline-flex h-11 items-center gap-2 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill">
              <RotateCcw className="h-4 w-4" aria-hidden /> Play another round
            </button>
            <a href="/play?mode=guess" className="inline-flex h-11 items-center rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
              Try Guess the percentile
            </a>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-5">
          {pair.map((e, side) => {
            const mine = pick === side;
            const state = pick === null ? "" : mine ? "win-pop" : "lose-dim";
            return (
              <div
                key={`${i}-${side}`}
                className={`card group relative overflow-hidden ${pick === null ? "card-hover deal-in" : ""} ${state} ${mine ? "ring-2 ring-accent" : ""}`}
                style={{ "--d": `${side * 90}ms` } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => vote(side as 0 | 1)}
                  disabled={pick !== null}
                  aria-label={`Pick ${e.name}`}
                  aria-keyshortcuts={side === 0 ? "ArrowLeft" : "ArrowRight"}
                  className="relative block aspect-[390/560] w-full text-left disabled:cursor-default md:aspect-[16/10]"
                >
                  <Frame e={e} eager />
                  {pick === null && (
                    <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100 md:flex">
                      <span className="rounded-full bg-fill px-4 py-2 text-sm font-bold text-on-fill shadow-lg">Pick this one</span>
                    </span>
                  )}
                  {pick !== null && <Share pct={pct[side]} mine={mine} k={`${i}-${side}`} />}
                </button>
                <div className="flex flex-wrap items-center gap-2 p-3 sm:p-4">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{e.name}</span>
                    <span className="block truncate text-xs text-mute sm:text-sm">{e.domain}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Details
                      name={e.name}
                      domain={e.domain}
                      url={e.url}
                      shot={e.shot}
                      card={e.card}
                      compact
                      hideScores={pick === null && !showScores}
                      hiddenWhy="Scores stay hidden until you vote, so votes stay honest. You can change this below the cards."
                      initialOpen={!!details && side === 0 && i === 0}
                      initialView={details}
                    />
                    <SiteActions url={e.url} name={e.name} compact />
                  </span>
                  <kbd className={`hidden h-7 min-w-7 place-items-center rounded-md border border-edge px-1.5 text-xs text-mute ${pick === null ? "lg:grid" : ""}`} aria-hidden>
                    {side === 0 ? "←" : "→"}
                  </kbd>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!finished && (
        <div className="mt-4 flex min-h-12 items-center justify-between gap-2">
          {pick === null ? (
            <>
              <p className="hidden text-sm text-mute md:block">
                Press <kbd className="rounded border border-edge px-1.5 text-xs">←</kbd> or <kbd className="rounded border border-edge px-1.5 text-xs">→</kbd> to pick,{" "}
                <kbd className="rounded border border-edge px-1.5 text-xs">S</kbd> to skip.
              </p>
              <p className="text-sm text-mute md:hidden">Tap the one you&apos;d hire from.</p>
              <label className="flex items-center gap-2 text-xs text-mute">
                <input
                  type="checkbox"
                  checked={showScores}
                  onChange={(e) => {
                    setShowScores(e.target.checked);
                    try {
                      localStorage.setItem("pr-show-scores", e.target.checked ? "1" : "0");
                    } catch {}
                  }}
                  className="h-4 w-4 accent-[var(--color-fill)]"
                />
                Show scores before voting
              </label>
              <button type="button" onClick={next} aria-keyshortcuts="S" className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-mute transition hover:bg-raised hover:text-ink">
                <SkipForward className="h-4 w-4" aria-hidden /> Skip
              </button>
            </>
          ) : (
            <>
              <p role="status" className="pop-in min-w-0 text-sm">
                <span className="font-semibold">{pct[pick] >= 50 ? "With the crowd." : "You picked the underdog."}</span>{" "}
                <span className="text-mute">{voted ? "Counted." : `Practice vote ${Math.min(done, 10)} of 10.`}</span>
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    if (pct[pick] >= 50) setAgreed((a) => a - 1);
                    setPick(null);
                    setDone((c) => c - 1);
                  }}
                  className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-mute transition hover:bg-raised hover:text-ink"
                >
                  <Undo2 className="h-4 w-4" aria-hidden /> Undo
                </button>
                <button type="button" onClick={next} autoFocus className="group btn-sheen inline-flex h-11 items-center gap-1.5 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill transition">
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
