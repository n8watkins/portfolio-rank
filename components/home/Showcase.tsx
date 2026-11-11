"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { RankBadge } from "@/components/ui/badges";
import { useReducedMotion } from "@/components/ui/motion";
import { btnIcon } from "@/components/ui/styles";
import type { ShowItem } from "@/lib/home";

const EVERY = 4200;

/**
 * The hero's card deck of top portfolios (owner, 2026-11-10: option A).
 * One rule for clicks: only the front card is a link (to its report), with a
 * "See report" label on hover and focus; the cards behind are decoration.
 * Cards change with the buttons, the dots or a swipe. The deck also advances
 * every few seconds, but pauses on hover, focus or the pause button, and
 * never moves on its own under reduced motion. The caption always names the
 * front card.
 */
export function Showcase({ items }: { items: ShowItem[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [touchX, setTouchX] = useState<number | null>(null);
  const still = useReducedMotion();
  const n = items.length;
  useEffect(() => {
    if (paused || hover || focus || still || n < 2) return;
    const t = setTimeout(() => setI((k) => (k + 1) % n), EVERY);
    return () => clearTimeout(t);
  }, [i, paused, hover, focus, still, n]);

  const go = (d: number) => setI((k) => (k + d + n) % n);
  const cur = items[i];
  const stopped = paused || still;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
      role="region"
      aria-roledescription="carousel"
      aria-label="Top graded portfolios"
    >
      <div
        className="relative aspect-[16/11] overflow-x-clip [perspective:1400px]"
        onTouchStart={(e) => setTouchX(e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX === null) return;
          const dx = e.changedTouches[0].clientX - touchX;
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
          setTouchX(null);
        }}
      >
        {items.map((it, k) => {
          const pos = (k - i + n) % n; // 0 = front
          if (pos > 3) return null;
          const style = {
            transform: `translate3d(${pos * 22}px, ${pos * -18}px, ${pos * -70}px) rotate(${pos === 0 ? -2.5 : pos * 2.2}deg)`,
            zIndex: 10 - pos,
            opacity: pos === 3 ? 0 : 1 - pos * 0.18,
          };
          const frame =
            "absolute inset-x-[6%] top-[8%] bottom-[2%] overflow-hidden rounded-2xl border border-edge-strong bg-card shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)] transition-[transform,opacity] duration-700 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";
          const img = (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={it.hero}
              alt={pos === 0 ? `Screenshot of ${it.domain}` : ""}
              loading={k < 3 ? "eager" : "lazy"}
              fetchPriority={k === 0 ? "high" : undefined}
              decoding="async"
              className="h-full w-full bg-raised object-cover object-top"
            />
          );
          if (pos !== 0)
            return (
              // Behind the front card: decoration only.
              <div key={it.url} aria-hidden className={`${frame} pointer-events-none`} style={style}>
                {img}
              </div>
            );
          return (
            <a key={it.url} href={it.href} aria-label={`See the report for ${it.name}`} className={`${frame} group cursor-pointer`} style={style}>
              {img}
              <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur" aria-hidden>
                #{it.rank} · Tier {it.tier}
              </span>
              <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/35 group-focus-visible:bg-black/35" aria-hidden>
                <span className="translate-y-1 rounded-full bg-black/75 px-4 py-2 text-sm font-semibold text-white opacity-0 shadow-lg backdrop-blur transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                  See report →
                </span>
              </span>
            </a>
          );
        })}
        <span className="pointer-events-none absolute inset-x-[10%] -bottom-6 h-16 rounded-full bg-[radial-gradient(closest-side,rgba(251,191,36,0.22),transparent)] blur-xl" aria-hidden />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        {/* The caption names the front card; it isn't a second link. */}
        <p className="flex min-w-0 items-center gap-2.5" aria-live={stopped ? "polite" : "off"}>
          <RankBadge rank={cur.rank} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{cur.name}</span>
            <span className="block truncate text-xs text-mute">
              {cur.domain} · Tier {cur.tier}
            </span>
          </span>
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="mr-1 hidden items-center sm:flex" role="group" aria-label="Choose a portfolio">
            {items.map((it, k) => (
              <button
                key={it.url}
                type="button"
                aria-label={`${k + 1}: ${it.name}`}
                aria-current={k === i ? "true" : undefined}
                onClick={() => setI(k)}
                className="group/dot grid h-6 place-items-center px-[3px]"
              >
                <span className={`block h-1.5 rounded-full transition-all duration-300 ${k === i ? "w-5 bg-fill" : "w-1.5 bg-edge-strong group-hover/dot:bg-mute"}`} />
              </button>
            ))}
          </span>
          <span className="mr-1 text-xs tabular-nums text-mute" aria-hidden>
            {i + 1} of {n}
          </span>
          <button type="button" onClick={() => go(-1)} aria-label="Previous portfolio" className={btnIcon}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Play the showcase" : "Pause the showcase"}
            // Under reduced motion the deck never moves on its own: nothing to pause.
            className={`${btnIcon} motion-reduce:hidden`}
          >
            {paused ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next portfolio" className={btnIcon}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
    </div>
  );
}
