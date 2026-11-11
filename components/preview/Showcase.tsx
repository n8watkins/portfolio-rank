"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { RankBadge } from "@/components/preview/bits";

export type ShowItem = { name: string; domain: string; shot: string; slug: string; tier: string; rank: number };

const EVERY = 4200;

/**
 * The hero's showcase of top portfolios.
 * A: a tilted card deck. B: a browser-frame carousel.
 * One rule for clicks: only the front card is a link (to its report), with a
 * "See report" label on hover and focus; the cards behind are decoration.
 * Cards change with the arrows, the dots or a swipe. It also advances every
 * few seconds, but pauses on hover, focus or the pause button, and never
 * moves on its own under reduced motion.
 */
export function Showcase({ items, variant = "a" }: { items: ShowItem[]; variant?: "a" | "b" }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [still, setStill] = useState(false);
  const [touchX, setTouchX] = useState<number | null>(null);
  useEffect(() => setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  useEffect(() => {
    if (paused || hover || focus || still) return;
    const t = setTimeout(() => setI((n) => (n + 1) % items.length), EVERY);
    return () => clearTimeout(t);
  }, [i, paused, hover, focus, still, items.length]);

  const go = (d: number) => setI((n) => (n + d + items.length) % items.length);
  const cur = items[i];

  const controls = (
    <div className="mt-4 flex items-center justify-between gap-3">
      {/* The caption names the front card; it isn't a second link. */}
      <p className="flex min-w-0 items-center gap-2.5" aria-live="polite">
        <RankBadge rank={cur.rank} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{cur.name}</span>
          <span className="block truncate text-xs text-mute">
            {cur.domain} · Tier {cur.tier}
          </span>
        </span>
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <span className="mr-1.5 hidden items-center gap-2 sm:flex">
          <span className="flex items-center gap-1" role="tablist" aria-label="Choose a portfolio">
            {items.map((it, k) => (
              <button
                key={it.slug}
                type="button"
                role="tab"
                aria-selected={k === i}
                aria-label={`${k + 1}: ${it.name}`}
                onClick={() => setI(k)}
                className={`h-1.5 rounded-full transition-all duration-300 ${k === i ? "w-5 bg-fill" : "w-1.5 bg-edge-strong hover:bg-mute"}`}
              />
            ))}
          </span>
          <span className="text-xs tabular-nums text-mute">
            {i + 1} of {items.length}
          </span>
        </span>
        <span className="mr-1.5 text-xs tabular-nums text-mute sm:hidden">
          {i + 1} of {items.length}
        </span>
        <button type="button" onClick={() => go(-1)} aria-label="Previous portfolio" className="grid h-9 w-9 place-items-center rounded-lg border border-edge bg-card text-mute shadow-[var(--card-hi)] hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-label={paused || still ? "Play the showcase" : "Pause the showcase"}
          className="grid h-9 w-9 place-items-center rounded-lg border border-edge bg-card text-mute shadow-[var(--card-hi)] hover:text-ink"
        >
          {paused || still ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
        </button>
        <button type="button" onClick={() => go(1)} aria-label="Next portfolio" className="grid h-9 w-9 place-items-center rounded-lg border border-edge bg-card text-mute shadow-[var(--card-hi)] hover:text-ink">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </span>
    </div>
  );

  if (variant === "b") {
    // B: one browser frame, the screenshots crossfade inside it.
    return (
      <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} aria-roledescription="carousel" aria-label="Top portfolios">
        <div className="card overflow-hidden shadow-[var(--card-hi),0_40px_80px_-40px_rgba(0,0,0,0.8),0_0_60px_-20px_rgba(251,191,36,0.25)]">
          <div className="flex items-center gap-2 border-b border-edge bg-raised px-3 py-2">
            <span className="flex gap-1.5" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            </span>
            <span className="mx-auto truncate rounded-md bg-card px-3 py-0.5 text-xs text-mute">{cur.domain}</span>
          </div>
          <div className="relative aspect-[16/10] bg-raised">
            {items.map((it, k) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={it.slug}
                src={`${it.shot}/hero.jpg`}
                alt={k === i ? `Screenshot of ${it.domain}` : ""}
                aria-hidden={k !== i}
                loading={k < 2 ? "eager" : "lazy"}
                className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ${k === i ? "opacity-100" : "opacity-0"}`}
              />
            ))}
          </div>
        </div>
        {controls}
      </div>
    );
  }

  // A: a tilted deck; the front card slides away and the next comes forward.
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      aria-roledescription="carousel"
      aria-label="Top portfolios"
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
          const pos = (k - i + items.length) % items.length; // 0 = front
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
            <img src={`${it.shot}/hero.jpg`} alt={pos === 0 ? `Screenshot of ${it.domain}` : ""} loading={k < 3 ? "eager" : "lazy"} className="h-full w-full object-cover object-top" />
          );
          if (pos !== 0)
            return (
              // Behind the front card: decoration only.
              <div key={it.slug} aria-hidden className={`${frame} pointer-events-none`} style={style}>
                {img}
              </div>
            );
          return (
            <a key={it.slug} href={`/grade/${it.slug}`} aria-label={`See the report for ${it.name}`} className={`${frame} group cursor-pointer`} style={style}>
              {img}
              <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
                #{it.rank} · Tier {it.tier}
              </span>
              <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/35 group-focus-visible:bg-black/35">
                <span className="translate-y-1 rounded-full bg-black/75 px-4 py-2 text-sm font-semibold text-white opacity-0 shadow-lg backdrop-blur transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                  See report →
                </span>
              </span>
            </a>
          );
        })}
        <span className="pointer-events-none absolute inset-x-[10%] -bottom-6 h-16 rounded-full bg-[radial-gradient(closest-side,rgba(251,191,36,0.22),transparent)] blur-xl" aria-hidden />
      </div>
      {controls}
    </div>
  );
}
