"use client";

import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Odometer } from "@/components/ui/Odometer";
import { useReducedMotion } from "@/components/ui/motion";
import type { LiveStat } from "@/lib/home";

const PER = 4;
const EVERY = 4500;

function Value({ s }: { s: LiveStat }) {
  return /\d/.test(s.value) ? <Odometer value={s.value} /> : <span className="pop-in inline-block">{s.value}</span>;
}

/**
 * The Live card's numbers, four at a time: the pages turn every few seconds,
 * pause on hover, focus or the pause button, and stay put under reduced
 * motion. Each number rolls in like an odometer.
 */
export function LiveStats({ stats }: { stats: LiveStat[] }) {
  const pages = Math.ceil(stats.length / PER);
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const still = useReducedMotion();
  useEffect(() => {
    if (paused || hover || focus || still || pages < 2) return;
    const t = setTimeout(() => setPage((p) => (p + 1) % pages), EVERY);
    return () => clearTimeout(t);
  }, [page, paused, hover, focus, still, pages]);
  const shown = stats.slice(page * PER, page * PER + PER);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      <dl key={page} className="grid grid-cols-2 gap-2.5">
        {shown.map((s, k) => (
          <div key={s.key} className="deal-in min-w-0 rounded-xl border border-edge bg-bg/40 p-3" style={{ "--d": `${k * 70}ms` } as React.CSSProperties}>
            <dt className="flex items-center gap-2 text-xs text-mute">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--stat-${s.tone})` }} aria-hidden />
              <span className="truncate">{s.label}</span>
            </dt>
            <dd className="mt-1.5 truncate text-2xl font-bold tabular-nums">
              <Value s={s} />
            </dd>
          </div>
        ))}
      </dl>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center" role="group" aria-label="Pages of numbers">
            {Array.from({ length: pages }, (_, k) => (
              <button
                key={k}
                type="button"
                aria-label={`Page ${k + 1} of ${pages}`}
                aria-current={k === page ? "true" : undefined}
                onClick={() => setPage(k)}
                className="group/dot grid h-6 place-items-center px-[3px]"
              >
                <span className={`block h-1.5 rounded-full transition-all duration-300 ${k === page ? "w-6 bg-fill" : "w-1.5 bg-edge-strong group-hover/dot:bg-mute"}`} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Play the numbers" : "Pause the numbers"}
            className="grid h-8 w-8 place-items-center rounded-lg text-mute transition hover:bg-raised hover:text-ink motion-reduce:hidden"
          >
            {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </div>
      )}
    </div>
  );
}
