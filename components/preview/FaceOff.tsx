"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, SkipForward, Undo2, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { isTextField } from "@/lib/dom";

export type Entry = { name: string; domain: string; shot: string; tagline?: string; slug: string };

function Frame({ e, eager }: { e: Entry; eager: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="grid grid-cols-1 h-full w-full place-items-center bg-raised p-3 text-center text-xs text-mute">{e.domain}</div>;
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

/** Two portfolios, pick one; the result shows on the cards themselves. */
export function FaceOff({ pairs, voted }: { pairs: [Entry, Entry][]; voted: boolean }) {
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<0 | 1 | null>(null);
  const [intro, setIntro] = useState(!voted);
  const [count, setCount] = useState(0);
  const pair = pairs[i % pairs.length];
  // Sample share of people who picked the left one.
  const leftPct = 35 + ((i * 29) % 40);
  const pct = [leftPct, 100 - leftPct];

  const vote = useCallback(
    (side: 0 | 1) => {
      if (pick !== null) return;
      setPick(side);
      setCount((c) => c + 1);
      setIntro(false);
    },
    [pick]
  );
  const next = useCallback(() => {
    setPick(null);
    setI((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || isModalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (pick === null && e.key === "ArrowLeft") vote(0);
      else if (pick === null && e.key === "ArrowRight") vote(1);
      else if (e.key === "s" || e.key === "S" || (pick !== null && (e.key === "Enter" || e.key === "ArrowRight"))) {
        e.preventDefault();
        next();
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, vote, next]);

  return (
    <div>
      {intro && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3.5 text-sm">
          <p className="min-w-0 flex-1">
            <strong>Pick the portfolio you&apos;d rather hire from.</strong> Your first 10 votes are practice: you see how others voted, and they count once you sign in.
          </p>
          <button type="button" onClick={() => setIntro(false)} aria-label="Dismiss" className="-m-2 grid grid-cols-1 h-10 w-10 shrink-0 place-items-center rounded-lg text-mute hover:text-ink">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
        {pair.map((e, side) => {
          const mine = pick === side;
          return (
            <button
              key={`${i}-${side}`}
              type="button"
              onClick={() => vote(side as 0 | 1)}
              disabled={pick !== null}
              aria-label={`Pick ${e.name}`}
              aria-keyshortcuts={side === 0 ? "ArrowLeft" : "ArrowRight"}
              className={`group relative overflow-hidden rounded-2xl border bg-card text-left transition disabled:cursor-default ${
                mine ? "border-accent ring-2 ring-accent" : pick !== null ? "border-edge opacity-80" : "border-edge hover:border-mute"
              }`}
            >
              <div className="relative aspect-[390/560] w-full md:aspect-[16/10]">
                <Frame e={e} eager />
                {pick !== null && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/60 to-transparent p-3 pt-10 text-white">
                    {mine && (
                      <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-xs font-bold text-on-fill">
                        <Check className="h-3 w-3" aria-hidden /> Your pick
                      </span>
                    )}
                    <p className="text-2xl font-bold tabular-nums">{pct[side]}%</p>
                    <p className="text-xs text-white/80">of people picked this</p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 p-2.5 sm:p-3.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{e.name}</span>
                  <span className="block truncate text-xs text-mute">{e.domain}</span>
                </span>
                <kbd className={`hidden h-6 min-w-6 place-items-center rounded border border-edge px-1.5 text-xs text-mute ${pick === null ? "md:grid" : ""}`} aria-hidden>
                  {side === 0 ? "←" : "→"}
                </kbd>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex min-h-12 items-center justify-between gap-2 sm:mt-4">
        {pick === null ? (
          <>
            <p className="hidden text-sm text-mute md:block">
              Press <kbd className="rounded border border-edge px-1.5 text-xs">←</kbd> or <kbd className="rounded border border-edge px-1.5 text-xs">→</kbd> to pick,{" "}
              <kbd className="rounded border border-edge px-1.5 text-xs">S</kbd> to skip.
            </p>
            <p className="text-sm text-mute md:hidden">Tap the one you&apos;d hire from.</p>
            <button type="button" onClick={next} aria-keyshortcuts="S" className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-mute transition hover:bg-raised hover:text-ink">
              <SkipForward className="h-4 w-4" aria-hidden /> Skip
            </button>
          </>
        ) : (
          <>
            <p role="status" className="min-w-0 text-sm">
              <span className="font-semibold">{pct[pick] >= 50 ? "Most people agree." : "You picked the underdog."}</span>{" "}
              <span className="text-mute">{voted ? "Counted." : `Practice vote ${Math.min(count, 10)} of 10.`}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setPick(null);
                  setCount((c) => c - 1);
                }}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-mute transition hover:bg-raised hover:text-ink"
              >
                <Undo2 className="h-4 w-4" aria-hidden /> Undo
              </button>
              <button type="button" onClick={next} autoFocus className="inline-flex h-11 items-center gap-1.5 btn-sheen group rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill transition">
                Next <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
