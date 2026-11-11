"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, Check, Merge, Share2, Shuffle, Swords, Target, Users, X } from "lucide-react";
import { isModalOpen } from "@/components/Modal";
import { SiteActions } from "@/components/play/SiteActions";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Burst, useCountUp, useReducedMotion } from "@/components/ui/motion";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { isTextField } from "@/lib/dom";
import { frameOf } from "@/lib/shot-url";

// Guess the percentile on the real games API (lib/games, GAMES_V2): five
// portfolios, guess where each lands among all of them ("top X%"), then
// see the real place in Merged, AI and People. The Daily 5 is the same for
// everyone that day; a random quiz's link replays the same five for a
// friend. A percentile never reaches the page before its guess: the API
// sends it only in the answer to that guess.

type Round = { index: number; url: string; name: string; tagline: string | null; domain: string; path: string; shot: string | null };
type Result = { index: number; guess: number; merged: number | null; ai: number | null; people: number | null; points: number; hit: boolean };
type Progress = { results: Result[]; finished: boolean; score: number; hits: number };
type Quiz = { id: string; kind: string; day: string | null; challenge: string; hit: number; rounds: Round[]; progress: Progress };
type Eye = { crowd: { agree: number; of: number; pct: number | null }; ai: { agree: number; of: number; pct: number | null } };

const QUICK = [1, 10, 25, 50, 75];
/** Misses within this many points are "so close" (owner: generous scoring). */
const NEAR = 25;
const START = 25;

const dayLabel = (day: string | null) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
const off = (r: Result) => (r.merged == null ? null : Math.abs(r.guess - r.merged));

function verdict(d: number | null, hit: number) {
  if (d == null) return "Not counted";
  if (d <= 4) return "Spot on";
  if (d <= hit) return "Nice, a hit";
  if (d <= NEAR) return "So close";
  return "Missed this one";
}

export function GuessPercentile({ quizId, guest, onBadgeCheck }: { quizId: string | null; guest: boolean; onBadgeCheck: (now?: boolean) => void }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "empty" | "error">("loading");
  const [i, setI] = useState(0);
  const [guess, setGuess] = useState(START);
  const [results, setResults] = useState<Result[]>([]);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [final, setFinal] = useState<{ score: number; hits: number } | null>(null);
  const [eye, setEye] = useState<Eye | null>(null);
  const reduced = useReducedMotion();
  const nextRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  const start = useCallback((q: Quiz) => {
    const done = q.progress.results;
    setQuiz(q);
    setResults(done);
    setI(Math.min(done.length, q.rounds.length));
    setShown(false);
    setGuess(START);
    setFinal(q.progress.finished ? { score: q.progress.score, hits: q.progress.hits } : null);
    setState("ready");
  }, []);

  const open = useCallback(
    async (id: string | null) => {
      setState("loading");
      try {
        const res = await fetch(id ? `/api/games/quiz/${encodeURIComponent(id)}` : "/api/games/quiz", { cache: "no-store" });
        if (res.status === 404) return setState("missing");
        if (res.status === 503) return setState("empty");
        if (!res.ok) return setState("error");
        start((await res.json()).quiz);
      } catch {
        setState("error");
      }
    },
    [start]
  );

  useEffect(() => {
    // open() sets state only after its fetch settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    open(quizId);
  }, [open, quizId]);

  // Back and Forward between quizzes this page pushed.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search);
      if (p.get("mode") === "guess") open(p.get("quiz"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open]);

  /** Today's Daily 5, or a new random quiz, without leaving the page; the address follows. */
  const switchTo = async (kind: "daily" | "random") => {
    if (busy) return;
    if (kind === "daily") {
      window.history.pushState(null, "", "/play?mode=guess");
      return open(null);
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/games/quiz", { method: "POST" });
      if (res.status === 429) setNote("That's a lot of quizzes for one hour. Try again a little later.");
      else if (!res.ok) setNote("Couldn't start a quiz. Try again.");
      else {
        const q: Quiz = (await res.json()).quiz;
        window.history.pushState(null, "", q.challenge);
        start(q);
        requestAnimationFrame(() => headRef.current?.focus());
      }
    } catch {
      setNote("Couldn't start a quiz. Try again.");
    }
    setBusy(false);
  };

  const finishedAll = quiz != null && i >= quiz.rounds.length;
  const round = quiz && !finishedAll ? quiz.rounds[i] : null;
  const last = shown ? results[results.length - 1] : null;

  const submit = useCallback(async () => {
    if (!quiz || !round || shown || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/games/quiz/${encodeURIComponent(quiz.id)}/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: round.index, guess }),
      });
      const data = await res.json().catch(() => ({}));
      const result: Result | undefined = data.result;
      if ((res.ok || res.status === 409) && result) {
        setResults((rs) => [...rs.filter((r) => r.index !== result.index), result]);
        setShown(true);
        if (res.ok && data.finished) setFinal({ score: data.finished.score, hits: data.finished.hits });
        if (!reduced) navigator.vibrate?.(result.hit ? [10, 40, 10] : 12);
        if (data.badges?.length) onBadgeCheck(true);
        requestAnimationFrame(() => nextRef.current?.focus());
      } else if (res.status === 429) setNote("That's a lot of guesses for one hour. Try again a little later.");
      else setNote("That guess didn't go through. Try again.");
    } catch {
      setNote("That guess didn't go through. Try again.");
    }
    setBusy(false);
  }, [quiz, round, shown, busy, guess, reduced, onBadgeCheck]);

  const next = useCallback(() => {
    setShown(false);
    setGuess(START);
    setI((n) => n + 1);
    requestAnimationFrame(() => headRef.current?.focus());
  }, []);

  // The end card's "Your eye", once the quiz is done.
  useEffect(() => {
    if (!finishedAll || eye) return;
    let live = true;
    fetch("/api/games/eye", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d?.eye && setEye(d.eye))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [finishedAll, eye]);

  // Enter locks the guess in, then goes on (but never steals a button's or a link's own Enter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || isModalOpen() || isTextField(e.target) || finishedAll) return;
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
      e.preventDefault();
      if (shown) next();
      else submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, next, submit, finishedAll]);

  const daily = quiz?.kind === "daily";
  const total = results.reduce((n, r) => n + r.points, 0);

  const tabs = (
    <nav aria-label="Quiz" className="mb-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => switchTo("daily")}
        aria-current={daily ? "page" : undefined}
        className="inline-flex h-9 items-center rounded-full border border-edge bg-card px-3.5 text-sm font-medium transition hover:border-edge-strong aria-[current=page]:border-accent/60 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent sm:h-8 sm:px-3"
      >
        Daily 5
      </button>
      <button
        type="button"
        onClick={() => switchTo("random")}
        disabled={busy}
        aria-current={quiz && !daily ? "page" : undefined}
        className="inline-flex h-9 items-center rounded-full border border-edge bg-card px-3.5 text-sm font-medium transition hover:border-edge-strong disabled:opacity-60 aria-[current=page]:border-accent/60 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent sm:h-8 sm:px-3"
      >
        Random quiz
      </button>
      <span className="text-xs text-mute">{daily || !quiz ? "Same five for everyone today." : "Share the link and a friend gets the same five."}</span>
    </nav>
  );

  if (state !== "ready" || !quiz) {
    return (
      <>
        {tabs}
        {state === "loading" ? (
          <div aria-busy="true" className="grid grid-cols-1 gap-4 sm:gap-5">
            <p role="status" className="sr-only">
              Loading the quiz
            </p>
            <div className="h-5" />
            <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <div className="card aspect-[390/360] animate-pulse md:aspect-[16/11]" />
              <div className="card min-h-80 animate-pulse" />
            </div>
          </div>
        ) : state === "missing" ? (
          <EmptyState icon={Target} title="That quiz link doesn't work." action={<button type="button" onClick={() => switchTo("daily")} className={btnPrimary}>Play today&apos;s Daily 5</button>}>
            It may have been mistyped. Today&apos;s Daily 5 is ready.
          </EmptyState>
        ) : state === "empty" ? (
          <EmptyState icon={Target} title="No graded portfolios yet.">
            The quiz needs graded portfolios to guess. Try the face-off meanwhile.
          </EmptyState>
        ) : (
          <EmptyState icon={Target} title="Couldn't load the quiz." action={<button type="button" onClick={() => open(quizId)} className={btnPrimary}>Retry</button>}>
            Check your connection and try again.
          </EmptyState>
        )}
        {note && <p role="status" className="mt-3 text-sm font-medium text-accent">{note}</p>}
      </>
    );
  }

  if (finishedAll) {
    const hits = final?.hits ?? results.filter((r) => r.hit).length;
    const score = final?.score ?? total;
    const nears = results.filter((r) => !r.hit && off(r) != null && off(r)! <= NEAR).length;
    const n = quiz.rounds.length;
    const link = typeof window === "undefined" ? quiz.challenge : `${window.location.origin}${quiz.challenge}`;
    const text = `I guessed ${hits} of ${n} within ${quiz.hit} points on PortfolioRank${daily ? ` (Daily 5, ${dayLabel(quiz.day)})` : ""}. Can you beat it? ${link}`;
    const shared = () => {
      fetch("/api/badges", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "share" }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.badges?.length && onBadgeCheck(true))
        .catch(() => {});
    };
    return (
      <>
        {tabs}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section aria-labelledby="result" className="card pop-in relative overflow-hidden p-6 sm:p-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(30rem_14rem_at_50%_0,var(--glow),transparent_70%)]" aria-hidden />
            <div className="relative">
              <p className="flex items-center justify-between gap-2 text-xs font-semibold tracking-[0.14em] text-mute uppercase">
                <span>{daily ? `Daily 5 · ${dayLabel(quiz.day)}` : "Guess the percentile"}</span>
                <span className="flex items-center gap-1.5 tracking-normal normal-case">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/pr-logo.svg" alt="" width={20} height={20} className="h-5 w-5" /> PortfolioRank
                </span>
              </p>
              <h2 id="result" ref={headRef} tabIndex={-1} className="mt-4 scroll-mt-24 text-3xl font-bold tracking-tight outline-none sm:text-4xl">
                {hits === n ? `Perfect: ${n} of ${n}!` : `${hits} of ${n} within ${quiz.hit} points`}
              </h2>
              {nears > 0 && (
                <p className="pop-in mt-1 font-semibold text-accent" style={{ animationDelay: "300ms" }}>
                  {nears === 1 ? "And one so close." : `And ${nears} so close.`}
                </p>
              )}
              <p className="mt-1 text-mute">
                Score <strong className="text-ink tabular-nums">{score}</strong> of {n * 100}
              </p>
              <ol className="mt-5 grid grid-cols-5 gap-2" aria-label="Each guess">
                {quiz.rounds.map((rd, k) => {
                  const r = results.find((x) => x.index === rd.index);
                  const d = r ? off(r) : null;
                  const ok = Boolean(r?.hit);
                  const near = !ok && d != null && d <= NEAR;
                  const what = ok ? "Hit" : near ? "So close" : "Missed";
                  return (
                    <li
                      key={rd.index}
                      className={`pop-in rounded-xl border p-2 text-center ${ok ? "border-up/40 bg-up/10" : near ? "border-accent/40 bg-accent-soft" : "border-edge bg-raised"}`}
                      style={{ animationDelay: `${k * 90}ms` }}
                    >
                      <span className={`mx-auto grid h-7 w-7 place-items-center rounded-full ${ok ? "bg-up text-white" : near ? "bg-fill text-on-fill" : "bg-edge-strong text-card"}`}>
                        {ok ? <Check className="h-4 w-4" aria-hidden /> : near ? <Target className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
                      </span>
                      <span className="sr-only">
                        {rd.name}: {what}, you said top {r?.guess}%{r?.merged != null ? `, it's top ${r.merged}%` : ""}.
                      </span>
                      <span className="mt-1.5 block text-[11px] text-mute tabular-nums" aria-hidden>
                        {r?.guess ?? "-"} / {r?.merged ?? "-"}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 text-xs text-mute">
                Each box: your guess / the real top %. Green within {quiz.hit}, amber within {NEAR}.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <CopyButton text={text} label="Share result" icon={Share2} buttonClass={btnPrimary} onCopied={shared} />
                <CopyButton text={link} label="Challenge a friend" icon={Swords} buttonClass={btnSecondary} onCopied={shared} />
              </div>
              <p className="mt-3 text-xs text-mute">A friend who opens the challenge link gets the same five portfolios.</p>
            </div>
          </section>

          <div className="flex flex-col gap-5">
            <section aria-labelledby="eye" className="card p-5 sm:p-6">
              <h2 id="eye" className="text-lg font-bold tracking-tight">
                Your eye
              </h2>
              <p className="mt-1 text-sm text-mute">Across your quizzes and face-offs.</p>
              <dl className="mt-4 grid grid-cols-2 gap-2.5">
                {[
                  { label: "Agree with the crowd", v: eye?.crowd, Icon: Users },
                  { label: "Agree with the AI", v: eye?.ai, Icon: Bot },
                ].map(({ label, v, Icon }) => (
                  <div key={label} className="rounded-xl border border-edge bg-bg/40 p-3">
                    <dt className="flex items-center gap-1.5 text-xs text-mute">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                    </dt>
                    <dd className="mt-1 text-2xl font-bold tabular-nums">{v?.pct != null ? <Count v={v.pct} suffix="%" /> : <span className="text-mute">-</span>}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-sm text-mute">
                {eye && (eye.crowd.of > 0 || eye.ai.of > 0)
                  ? `From ${Math.max(eye.crowd.of, eye.ai.of)} of your votes and guesses that the boards can check.`
                  : "It fills in as you vote and guess and the boards settle."}
              </p>
            </section>
            <section className="card flex flex-1 flex-col p-5 sm:p-6">
              <h2 className="text-lg font-bold tracking-tight">Play again</h2>
              <p className="mt-1 text-sm text-mute">{daily ? "A new Daily 5 comes tomorrow. Random quizzes never run out." : "Another five, picked at random."}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <button type="button" onClick={() => switchTo("random")} disabled={busy} className={btnSecondary}>
                  <Shuffle className="h-4 w-4" aria-hidden /> Random quiz
                </button>
                <a href="/play" className="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-mute hover:text-ink">
                  Face-off instead
                </a>
              </div>
              {note && <p role="status" className="mt-3 text-sm font-medium text-accent">{note}</p>}
            </section>
          </div>
        </div>
      </>
    );
  }

  const r = round!;
  const d = last ? off(last) : null;
  return (
    <>
      {tabs}
      <div className="grid grid-cols-1 gap-4 sm:gap-5">
        <div className="flex items-center gap-3">
          <h2 ref={headRef} tabIndex={-1} className="shrink-0 scroll-mt-24 text-sm font-semibold tabular-nums outline-none">
            <span className="max-sm:hidden">{daily ? `Daily 5 · ${dayLabel(quiz.day)}` : "Random quiz"} · </span>
            <span className="sr-only">Portfolio </span>
            {i + 1} / {quiz.rounds.length}
          </h2>
          <ol className="flex flex-1 gap-1.5" aria-hidden>
            {quiz.rounds.map((rd, k) => {
              const done = results.find((x) => x.index === rd.index);
              return <li key={k} className={`h-2 flex-1 rounded-full transition-colors duration-300 ${done ? (done.hit ? "bg-up" : "bg-edge-strong") : k === i ? "bg-fill/50" : "bg-edge"}`} />;
            })}
          </ol>
          <span className="shrink-0 text-sm text-mute tabular-nums">{total} pts</span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <figure key={r.index} className="card deal-in flex flex-col overflow-hidden">
            <div className="relative aspect-[390/290] w-full md:aspect-[16/10]">
              {r.shot ? (
                <picture>
                  <source media="(max-width: 767px)" srcSet={frameOf(r.shot, "mobile.jpg")} />
                  <img src={frameOf(r.shot, "hero.jpg")} alt={`Screenshot of ${r.domain}`} fetchPriority="high" className="absolute inset-0 h-full w-full bg-raised object-cover object-top" />
                </picture>
              ) : (
                <span role="img" aria-label={`No screenshot of ${r.domain}`} className="absolute inset-0 grid place-items-center bg-raised text-sm text-mute">
                  {r.domain}
                </span>
              )}
            </div>
            <figcaption className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="block truncate text-sm text-mute">{r.tagline ?? r.domain}</span>
              </span>
              {/* Details (the report) only after the guess: it shows the answer. */}
              <SiteActions url={r.url} name={r.name} details={shown} onSaved={() => onBadgeCheck()} />
            </figcaption>
          </figure>

          <section aria-label={shown ? "Result" : "Your guess"} className="card flex flex-col p-5 sm:p-6">
            {!shown || !last ? (
              <>
                <h3 className="text-lg font-bold tracking-tight">Where does it land?</h3>
                <p className="mt-1 text-sm text-mute">Guess its place among every graded portfolio, as a top percentage. Visit the site first if you like.</p>
                <p className="mt-5 text-center">
                  <span className="text-xs tracking-wider text-mute uppercase">Your guess</span>
                  <span className="block text-5xl font-bold tracking-tight tabular-nums">Top {guess}%</span>
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
                <div className="mt-4 grid grid-cols-5 gap-1.5" role="group" aria-label="Quick picks">
                  {QUICK.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setGuess(q)}
                      aria-pressed={guess === q}
                      className="card-hover h-11 rounded-lg border border-edge bg-card px-0.5 text-[11px] font-semibold whitespace-nowrap aria-pressed:border-accent aria-pressed:text-accent sm:h-10 sm:text-xs"
                    >
                      {q === 75 ? "Bottom" : `Top ${q}%`}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={submit} disabled={busy} className={`${btnPrimary} mt-auto h-12 text-[15px] max-lg:mt-5`}>
                  <Target className="icon-twinkle h-4 w-4" aria-hidden /> Lock in top {guess}%
                </button>
                <p className="mt-2 text-center text-xs text-mute">Within {quiz.hit} points is a hit; every guess scores at least 20.</p>
                {note && <p role="status" className="mt-2 text-center text-sm font-medium text-accent">{note}</p>}
              </>
            ) : (
              <>
                <p role="status" className="pop-in flex items-baseline justify-between gap-3">
                  <Burst on={last.hit}>
                    <span className="text-xl font-bold tracking-tight">{verdict(d, quiz.hit)}</span>
                  </Burst>
                  <span className="text-sm tabular-nums">
                    <Count v={last.points} k={i} prefix="+" className="text-2xl font-bold" /> <span className="text-mute">points</span>
                    <span className="sr-only">
                      . You said top {last.guess}%
                      {last.merged != null ? `; it's top ${last.merged}% merged, ${d} ${d === 1 ? "point" : "points"} off.` : "; it has left the board, so this round isn't counted."}
                    </span>
                  </span>
                </p>
                {last.merged != null && <Meter guess={last.guess} actual={last.merged} />}
                <p className="mt-2 text-sm text-mute" aria-hidden>
                  {last.merged != null
                    ? `You said top ${last.guess}%; it's top ${last.merged}% merged. ${d === 0 ? "Exactly right." : `${d} ${d === 1 ? "point" : "points"} off.`}`
                    : "This portfolio has left the board since the quiz was made, so this round isn't counted."}
                </p>
                <ul className="mt-4 grid grid-cols-3 gap-2">
                  {[
                    { label: "Merged", Icon: Merge, v: last.merged },
                    { label: "AI", Icon: Bot, v: last.ai },
                    { label: "People", Icon: Users, v: last.people },
                  ].map(({ label, Icon, v }) => (
                    <li key={label} className="rounded-xl border border-edge bg-bg/40 px-3 py-2.5">
                      <span className="flex items-center gap-1.5 text-xs text-mute">
                        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                      </span>
                      <span className="mt-0.5 block text-lg font-bold tabular-nums">{v != null ? `Top ${v}%` : <span className="text-mute">-</span>}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                  <button ref={nextRef} type="button" onClick={next} className={`${btnPrimary} h-12 flex-1 text-[15px]`}>
                    {i === quiz.rounds.length - 1 ? "See your result" : "Next portfolio"} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                  </button>
                  <a href={r.path} target="_blank" rel="noopener" className={`${btnSecondary} h-12`}>
                    Report
                  </a>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
      {guest && i === 0 && !shown && <p className="mt-3 text-xs text-mute">Playing as a guest: sign in to keep your scores and badges.</p>}
    </>
  );
}

function Count({ v, k = 0, prefix = "", suffix = "", className = "" }: { v: number; k?: number; prefix?: string; suffix?: string; className?: string }) {
  const n = useCountUp(v, k, 900);
  return (
    <span className={`tabular-nums ${className}`}>
      {prefix}
      {n}
      {suffix}
    </span>
  );
}

/** Your guess and the real percentile on a 1-100 scale, both labelled. */
function Meter({ guess, actual }: { guess: number; actual: number }) {
  const lo = Math.min(guess, actual);
  const hi = Math.max(guess, actual);
  const clamp = (v: number) => Math.min(90, Math.max(10, v));
  return (
    <div className="mt-4 rounded-xl border border-edge bg-bg/40 px-4 pt-4 pb-3" aria-hidden>
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
      <div className="relative h-5 text-[11px] text-mute tabular-nums">
        <span className="absolute left-0">1%</span>
        <span className="absolute right-0">100%</span>
        <span className="absolute -translate-x-1/2 font-semibold whitespace-nowrap text-ink" style={{ left: `${clamp(guess)}%` }}>
          you {guess}%
        </span>
      </div>
    </div>
  );
}
