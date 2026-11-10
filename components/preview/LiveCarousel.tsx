"use client";

import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useCountUp } from "@/components/preview/useCountUp";
import type { LiveStat } from "@/lib/preview/data";

const PER = 4;
const EVERY = 4500;

function Value({ s, k }: { s: LiveStat; k: number }) {
  const n = useCountUp(typeof s.value === "number" ? s.value : 0, k, 900);
  return (
    <>
      {typeof s.value === "number" ? n.toLocaleString() : s.value}
      {s.suffix}
    </>
  );
}

/** The Live card: pages of four numbers that slide in turn; pausable, still under reduced motion. */
export function LiveCarousel({ stats }: { stats: LiveStat[] }) {
  const pages = Math.ceil(stats.length / PER);
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const [hover, setHover] = useState(false);
  useEffect(() => setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  useEffect(() => {
    if (paused || hover || still) return;
    const t = setTimeout(() => setPage((p) => (p + 1) % pages), EVERY);
    return () => clearTimeout(t);
  }, [page, paused, hover, still, pages]);
  const shown = stats.slice(page * PER, page * PER + PER);

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <dl key={page} className="grid grid-cols-2 gap-2.5" aria-live="polite">
        {shown.map((s, k) => (
          <div key={s.key} className="deal-in rounded-xl border border-edge bg-bg/40 p-3" style={{ "--d": `${k * 70}ms` } as React.CSSProperties}>
            <dt className="flex items-center gap-2 text-xs text-mute">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--stat-${s.tone})` }} aria-hidden />
              <span className="truncate">{s.label}</span>
              {s.sample && <span className="sr-only">(sample)</span>}
            </dt>
            <dd className="mt-1.5 truncate text-2xl font-bold tabular-nums">
              <Value s={s} k={page} />
              {s.sample && (
                <span className="ml-1 align-super text-[10px] font-semibold text-mute" aria-hidden>
                  *
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Pages of numbers">
          {Array.from({ length: pages }, (_, k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === page}
              aria-label={`Page ${k + 1}`}
              onClick={() => setPage(k)}
              className={`h-1.5 rounded-full transition-all duration-300 ${k === page ? "w-6 bg-fill" : "w-1.5 bg-edge-strong hover:bg-mute"}`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-label={paused || still ? "Play" : "Pause"}
          className="grid h-8 w-8 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink"
        >
          {paused || still ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
    </div>
  );
}
