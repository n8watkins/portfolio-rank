"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, LayoutGrid, Sparkles, Vote } from "lucide-react";

type Stat = { key: string; label: string; value: number; sample: boolean };

const ICON = { portfolios: LayoutGrid, graded: Bot, grades: Sparkles, votes: Vote } as const;
const TONE: Record<string, string> = { portfolios: "var(--stat-1)", graded: "var(--stat-2)", grades: "var(--stat-3)", votes: "var(--stat-4)" };

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Counts up from zero the first time it scrolls into view. */
function useCountUp(target: number, start: boolean) {
  const [n, setN] = useState(target);
  const from = useRef<number | null>(null);
  useEffect(() => {
    if (!start || from.current !== null) return;
    from.current = 0;
    if (reduced()) return;
    const t0 = performance.now();
    const dur = 1100;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setN(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [start, target]);
  // Later changes (ticks) jump straight to the new value.
  useEffect(() => {
    if (from.current !== null) setN(target);
  }, [target]);
  return n;
}

function StatTile({ s, start, ticked }: { s: Stat; start: boolean; ticked: number }) {
  const n = useCountUp(s.value, start);
  const Icon = ICON[s.key as keyof typeof ICON];
  return (
    <div className="rounded-xl border border-edge bg-bg/40 p-3">
      <dt className="flex items-center gap-2 text-xs text-mute">
        <span
          key={ticked}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${ticked ? "stat-bump" : "stat-in"}`}
          style={{ color: TONE[s.key], background: `color-mix(in oklab, ${TONE[s.key]} 13%, transparent)` }}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        {s.label}
        {s.sample && <span className="sr-only">(sample)</span>}
      </dt>
      <dd key={`n${ticked}`} className={`mt-2 text-2xl font-bold tabular-nums ${ticked ? "stat-tick" : ""}`}>
        {n.toLocaleString()}
        {s.sample && (
          <span className="ml-1 align-super text-[10px] font-semibold text-mute" aria-hidden>
            *
          </span>
        )}
      </dd>
    </div>
  );
}

/** The Live numbers: count up when seen, then sample votes tick in. */
export function LiveStatsClient({ initial }: { initial: Stat[] }) {
  const [stats, setStats] = useState(initial);
  const [ticks, setTicks] = useState<Record<string, number>>({});
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLDListElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Sample activity: a vote every few seconds, a grade now and then.
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = (k: number) => {
      timer = setTimeout(() => {
        if (!alive) return;
        const key = k % 6 === 5 ? "grades" : "votes";
        const add = key === "votes" ? 1 + (k % 3) : 1;
        setStats((s) => s.map((x) => (x.key === key ? { ...x, value: x.value + add } : x)));
        setTicks((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 }));
        loop(k + 1);
      }, 2600 + (k % 4) * 700);
    };
    loop(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [seen]);

  return (
    <dl ref={ref} className="grid grid-cols-2 gap-2.5">
      {stats.map((s) => (
        <StatTile key={s.key} s={s} start={seen} ticked={ticks[s.key] ?? 0} />
      ))}
    </dl>
  );
}
