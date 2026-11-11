"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Bot, Check, CircleCheck, Copy, Merge, Shuffle, Swords, Target, Users, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { isTextField } from "@/lib/dom";
import { useCountUp } from "@/components/preview/useCountUp";
import { SiteActions } from "@/components/preview/SiteActions";
import { BadgeToast } from "@/components/preview/BadgeToast";
import { Details } from "@/components/preview/Details";
import { Burst } from "@/components/preview/Burst";
import type { QuizRound } from "@/lib/preview/data";

const QUICK = [1, 10, 25, 50, 75];
// Generous on purpose (owner, round 6): casual players should feel they're winning.
const HIT = 15; // within 15 points is a hit
const NEAR = 25; // within 25 is "so close"

/** 100 for exact, 2.5 less per point off, never under 20. */
const points = (g: number, a: number) => Math.max(20, Math.round(100 - Math.abs(g - a) * 2.5));

function verdict(d: number) {
  if (d <= 4) return "Spot on";
  if (d <= HIT) return "Nice, a hit";
  if (d <= NEAR) return "So close";
  return "Missed this one";
}

type Result = { guess: number; actual: number };

/**
 * Guess the percentile: five portfolios, guess where each lands ("top X%"),
 * then see the real percentile in Merged, AI and People. Ends on a result
 * card to share, with a challenge link that replays the same five.
 */
export function GuessPercentile({
  rounds,
  seed,
  daily,
  dayLabel,
  nextSeed,
  guest,
  preset,
  details,
}: {
  rounds: QuizRound[];
  seed: string;
  daily: boolean;
  dayLabel: string;
  nextSeed: string;
  guest: boolean;
  /** Screenshots: open on a reveal or on the end card. */
  preset?: "reveal" | "end";
  details?: "simple" | "advanced";
}) {
  const sampleEnd: Result[] = rounds.map((r, k) => ({ guess: Math.min(100, Math.max(1, r.merged + [4, -11, 21, 2, -9][k])), actual: r.merged }));
  const [i, setI] = useState(preset === "end" ? 5 : 0);
  const [guess, setGuess] = useState(preset === "reveal" ? Math.min(100, rounds[0].merged + 6) : 25);
  const [shown, setShown] = useState(preset === "reveal");
  const [results, setResults] = useState<Result[]>(preset === "end" ? sampleEnd : preset === "reveal" ? [{ guess: Math.min(100, rounds[0].merged + 6), actual: rounds[0].merged }] : []);
  const [copied, setCopied] = useState(false);
  const r = rounds[Math.min(i, 4)];
  const finished = i >= 5;
  const total = results.reduce((n, x) => n + points(x.guess, x.actual), 0);

  const submit = () => {
    if (shown || finished) return;
    setShown(true);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) navigator.vibrate?.(Math.abs(guess - r.merged) <= HIT ? [10, 40, 10] : 12);
    setResults((rs) => [...rs, { guess, actual: r.merged }]);
  };
  const next = () => {
    setShown(false);
    setGuess(25);
    setI((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || isModalOpen() || finished) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (shown) next();
        else submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hits = results.filter((x) => Math.abs(x.guess - x.actual) <= HIT).length;
  const nears = results.filter((x) => Math.abs(x.guess - x.actual) > HIT && Math.abs(x.guess - x.actual) <= NEAR).length;

  if (finished) {
    const link = `/play?mode=guess&quiz=${seed}`;
    const text = `I guessed ${hits} of 5 within ${HIT} points on PortfolioRank${daily ? ` (Daily 5, ${dayLabel})` : ""}. Can you beat it?`;
    return (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {/* The shareable result card */}
        <section aria-labelledby="result" className="card pop-in relative overflow-hidden p-6 sm:p-8">
          <div className="pointer-events-none absolute inset-0 -z-0 bg-[radial-gradient(30rem_14rem_at_50%_0,var(--glow),transparent_70%)]" aria-hidden />
          <div className="relative">
            <p className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-mute">
              <span>{daily ? `Daily 5 · ${dayLabel}` : "Guess the percentile"}</span>
              <span className="flex items-center gap-1.5 normal-case tracking-normal">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/pr-logo.svg" alt="" className="h-5 w-5" /> PortfolioRank
              </span>
            </p>
            <h2 id="result" className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
              {hits === 5 ? "Perfect: 5 of 5!" : `${hits} of 5 within ${HIT} points`}
            </h2>
            {nears > 0 && (
              <p className="pop-in mt-1 font-semibold text-accent" style={{ animationDelay: "300ms" }}>
                {nears === 1 ? "And one so close." : `And ${nears} so close.`}
              </p>
            )}
            <p className="mt-1 text-mute">
              Score <strong className="text-ink tabular-nums">{total}</strong> of 500
            </p>
            <ol className="mt-5 grid grid-cols-5 gap-2" aria-label="Each guess">
              {results.map((x, k) => {
                const off = Math.abs(x.guess - x.actual);
                const ok = off <= HIT;
                const near = !ok && off <= NEAR;
                return (
                  <li
                    key={k}
                    className={`pop-in rounded-xl border p-2 text-center ${ok ? "border-up/40 bg-up/10" : near ? "border-accent/40 bg-accent-soft" : "border-edge bg-raised"}`}
                    style={{ animationDelay: `${k * 90}ms` }}
                  >
                    <span className={`mx-auto grid h-7 w-7 place-items-center rounded-full ${ok ? "bg-up text-white" : near ? "bg-fill text-on-fill" : "bg-edge-strong text-card"}`}>
                      {ok ? <Check className="h-4 w-4" aria-label="Hit" /> : near ? <Target className="h-4 w-4" aria-label="So close" /> : <X className="h-4 w-4" aria-label="Missed" />}
                    </span>
                    <span className="mt-1.5 block text-[11px] tabular-nums text-mute">
                      {x.guess} / {x.actual}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-xs text-mute">Each box: your guess / the real top %. Green within {HIT}, amber within {NEAR}.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(`${text} ${location.origin}${link}`).catch(() => {});
                  setCopied(true);
                }}
                className="group btn-sheen inline-flex h-11 items-center gap-2 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill"
              >
                {copied ? <CircleCheck className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                {copied ? "Copied" : "Share result"}
              </button>
              <a href={link} className="inline-flex h-11 items-center gap-2 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
                <Swords className="h-4 w-4" aria-hidden /> Challenge a friend
              </a>
            </div>
            <p className="mt-3 text-xs text-mute">A friend who opens the challenge link gets the same five portfolios.</p>
          </div>
        </section>

        <div className="flex flex-col gap-5">
          {/* Your eye (sample) */}
          <section aria-labelledby="eye" className="card p-5 sm:p-6">
            <h2 id="eye" className="text-lg font-bold tracking-tight">
              Your eye
            </h2>
            <p className="mt-1 text-sm text-mute">Across your quizzes and face-offs. Sample numbers.</p>
            <dl className="mt-4 grid grid-cols-2 gap-2.5">
              {[
                { label: "Agree with the crowd", v: 72, Icon: Users },
                { label: "Agree with the AI", v: 61, Icon: Bot },
              ].map(({ label, v, Icon }) => (
                <div key={label} className="rounded-xl border border-edge bg-bg/40 p-3">
                  <dt className="flex items-center gap-1.5 text-xs text-mute">
                    <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                  </dt>
                  <dd className="mt-1 text-2xl font-bold tabular-nums">
                    <Count v={v} />%
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-sm">You rate design a little higher than most people do, and project stories lower than the AI does.</p>
          </section>
          <section className="card flex flex-1 flex-col p-5 sm:p-6">
            <h2 className="text-lg font-bold tracking-tight">Play again</h2>
            <p className="mt-1 text-sm text-mute">{daily ? "A new Daily 5 comes tomorrow. Random quizzes never run out." : "Another five, picked at random."}</p>
            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              <a href={`/play?mode=guess&quiz=${nextSeed}`} className="inline-flex h-11 items-center gap-2 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
                <Shuffle className="h-4 w-4" aria-hidden /> Random quiz
              </a>
              <a href="/play" className="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-mute hover:text-ink">
                Face-off instead
              </a>
            </div>
          </section>
        </div>
        <BadgeToast id="quiz" hue={200} name="First quiz" how="Finish a Guess the percentile quiz." guest={guest} />
      </div>
    );
  }

  const p = points(guess, r.merged);
  const d = Math.abs(guess - r.merged);
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5">
      {/* Five rounds, Wordle-style progress */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {daily ? `Daily 5 · ${dayLabel}` : "Random quiz"} · {i + 1} / 5
        </span>
        <ol className="flex flex-1 gap-1.5" aria-label={`Portfolio ${i + 1} of 5`}>
          {rounds.map((_, k) => {
            const done = results[k];
            const ok = done && Math.abs(done.guess - done.actual) <= HIT;
            return <li key={k} className={`h-2 flex-1 rounded-full transition-colors duration-300 ${done ? (ok ? "bg-up" : "bg-edge-strong") : k === i ? "bg-fill/50" : "bg-edge"}`} />;
          })}
        </ol>
        <span className="shrink-0 text-sm text-mute tabular-nums">{total} pts</span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <figure key={i} className="card deal-in flex flex-col overflow-hidden">
          <div className="relative aspect-[390/290] w-full md:aspect-[16/10]">
            <picture>
              <source media="(max-width: 767px)" srcSet={`${r.shot}/mobile.jpg`} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${r.shot}/hero.jpg`} alt={`Screenshot of ${r.domain}`} className="absolute inset-0 h-full w-full bg-raised object-cover object-top" />
            </picture>
          </div>
          <figcaption className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate font-semibold">{r.name}</span>
              <span className="block truncate text-sm text-mute">{r.tagline ?? r.domain}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Details
                name={r.name}
                domain={r.domain}
                url={r.url}
                shot={r.shot}
                card={r.card}
                hideScores={!shown}
                hiddenWhy="Tier and scores are hidden until you guess, so the quiz stays fair."
                initialOpen={!!details && i === 0}
                initialView={details}
              />
              <SiteActions url={r.url} name={r.name} />
            </span>
          </figcaption>
        </figure>

        <section aria-label={shown ? "Result" : "Your guess"} className="card flex flex-col p-5 sm:p-6">
          {!shown ? (
            <>
              <h2 className="text-lg font-bold tracking-tight">Where does it land?</h2>
              <p className="mt-1 text-sm text-mute">Guess its place among every graded portfolio, as a top percentage. Visit the site first if you like.</p>
              <p className="mt-5 text-center">
                <span className="text-xs uppercase tracking-wider text-mute">Your guess</span>
                <span className="block text-5xl font-bold tabular-nums tracking-tight" aria-live="polite">
                  Top {guess}%
                </span>
              </p>
              <label htmlFor="guess" className="sr-only">
                Your guess, top 1 to 100 percent
              </label>
              <input
                id="guess"
                type="range"
                min={1}
                max={100}
                value={guess}
                onChange={(e) => setGuess(Number(e.target.value))}
                aria-valuetext={`Top ${guess} percent`}
                className="mt-4 h-2 w-full cursor-pointer accent-[var(--color-fill)]"
              />
              <div className="mt-1 flex justify-between text-xs text-mute tabular-nums" aria-hidden>
                <span>Top 1%</span>
                <span>Top 50%</span>
                <span>100%</span>
              </div>
              <div className="mt-4 grid grid-cols-5 gap-1.5">
                {QUICK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setGuess(q)}
                    aria-pressed={guess === q}
                    className="card-hover h-10 whitespace-nowrap rounded-lg border border-edge bg-card px-0.5 text-[11px] font-semibold aria-pressed:border-accent aria-pressed:text-accent sm:text-xs"
                  >
                    {q === 75 ? "Bottom" : `Top ${q}%`}
                  </button>
                ))}
              </div>
              <button type="button" onClick={submit} className="group btn-sheen mt-auto inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-fill text-[15px] font-semibold text-on-fill max-lg:mt-5">
                <Target className="icon-twinkle h-4 w-4" aria-hidden /> Lock in top {guess}%
              </button>
              <p className="mt-2 text-center text-xs text-mute">Within {HIT} points is a hit; every guess scores at least 20.</p>
            </>
          ) : (
            <>
              <p role="status" className="pop-in flex items-baseline justify-between gap-3">
                <Burst on={d <= HIT}>
                  <span className="text-xl font-bold tracking-tight">{verdict(d)}</span>
                </Burst>
                <span className="text-sm tabular-nums">
                  <Count v={p} k={i} prefix="+" className="text-2xl font-bold" /> <span className="text-mute">points</span>
                </span>
              </p>
              <Meter guess={guess} actual={r.merged} />
              <p className="mt-2 text-sm text-mute">
                You said top {guess}%; it&apos;s top {r.merged}% merged. {d === 0 ? "Exactly right." : `${d} ${d === 1 ? "point" : "points"} off.`}
              </p>
              <ul className="mt-4 grid grid-cols-3 gap-2">
                {[
                  { label: "Merged", Icon: Merge, v: r.merged },
                  { label: "AI", Icon: Bot, v: r.ai },
                  { label: "People", Icon: Users, v: r.people },
                ].map(({ label, Icon, v }) => (
                  <li key={label} className="rounded-xl border border-edge bg-bg/40 px-3 py-2.5">
                    <span className="flex items-center gap-1.5 text-xs text-mute">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                    </span>
                    <span className="mt-0.5 block text-lg font-bold tabular-nums">Top {v}%</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                <button type="button" onClick={next} autoFocus={!preset} className="group btn-sheen inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-fill text-[15px] font-semibold text-on-fill">
                  {i === 4 ? "See your result" : "Next portfolio"} <ArrowRight className="nudge h-4 w-4" aria-hidden />
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

function Count({ v, k = 0, prefix = "", className = "" }: { v: number; k?: number; prefix?: string; className?: string }) {
  const n = useCountUp(v, k, 900);
  return (
    <span className={`tabular-nums ${className}`}>
      {prefix}
      {n}
    </span>
  );
}

/** Your guess and the real percentile on a 1-100 scale, both labelled. */
function Meter({ guess, actual }: { guess: number; actual: number }) {
  const lo = Math.min(guess, actual);
  const hi = Math.max(guess, actual);
  const clamp = (v: number) => Math.min(90, Math.max(10, v));
  return (
    <div className="mt-4 rounded-xl border border-edge bg-bg/40 px-4 pb-3 pt-4" aria-hidden>
      <div className="relative h-5 text-[11px] font-semibold tabular-nums">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-accent" style={{ left: `${clamp(actual)}%` }}>
          real top {actual}%
        </span>
      </div>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-edge" />
        <div className="bar-fill absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/45" style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%` }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-mute" style={{ left: `${guess}%` }} />
        <span className="pop-in absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-fill shadow" style={{ left: `${actual}%` }} />
      </div>
      <div className="relative h-5 text-[11px] tabular-nums text-mute">
        <span className="absolute left-0">1%</span>
        <span className="absolute right-0">100%</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap font-semibold text-ink" style={{ left: `${clamp(guess)}%` }}>
          you {guess}%
        </span>
      </div>
    </div>
  );
}
