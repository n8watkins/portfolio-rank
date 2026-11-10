"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { RankBadge } from "@/components/preview/bits";

export type ShowItem = { name: string; domain: string; shot: string; slug: string; tier: string; rank: number };

const EVERY = 4200;

/**
 * The hero's showcase of top portfolios, cycling every few seconds.
 * A: a tilted card deck. B: a browser-frame carousel. Pausable; under
 * reduced motion it never moves on its own.
 */
export function Showcase({ items, variant = "a" }: { items: ShowItem[]; variant?: "a" | "b" }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [still, setStill] = useState(false);
  useEffect(() => setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  useEffect(() => {
    if (paused || hover || still) return;
    const t = setTimeout(() => setI((n) => (n + 1) % items.length), EVERY);
    return () => clearTimeout(t);
  }, [i, paused, hover, still, items.length]);

  const go = (d: number) => setI((n) => (n + d + items.length) % items.length);
  const cur = items[i];

  const controls = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <a href={`/grade/${cur.slug}`} className="flex min-w-0 items-center gap-2.5" aria-live="polite">
        <RankBadge rank={cur.rank} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{cur.name}</span>
          <span className="block truncate text-xs text-mute">
            {cur.domain} · Tier {cur.tier}
          </span>
        </span>
      </a>
      <span className="flex shrink-0 items-center gap-1">
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
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} aria-roledescription="carousel" aria-label="Top portfolios">
      <div className="relative aspect-[16/11] overflow-x-clip [perspective:1400px]">
        {items.map((it, k) => {
          const pos = (k - i + items.length) % items.length; // 0 = front
          if (pos > 3) return null;
          const style = {
            transform: `translate3d(${pos * 22}px, ${pos * -18}px, ${pos * -70}px) rotate(${pos === 0 ? -2.5 : pos * 2.2}deg)`,
            zIndex: 10 - pos,
            opacity: pos === 3 ? 0 : 1 - pos * 0.18,
          };
          return (
            <a
              key={it.slug}
              href={`/grade/${it.slug}`}
              tabIndex={pos === 0 ? 0 : -1}
              aria-hidden={pos !== 0}
              className="absolute inset-x-[6%] top-[8%] bottom-[2%] overflow-hidden rounded-2xl border border-edge-strong bg-card shadow-[0_30px_60px_-30px_rgba(0,0,0,0.8)] transition-[transform,opacity] duration-700 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
              style={style}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${it.shot}/hero.jpg`} alt={pos === 0 ? `Screenshot of ${it.domain}` : ""} loading={k < 3 ? "eager" : "lazy"} className="h-full w-full object-cover object-top" />
              {pos === 0 && (
                <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
                  #{it.rank} · Tier {it.tier}
                </span>
              )}
            </a>
          );
        })}
        <span className="pointer-events-none absolute inset-x-[10%] -bottom-6 h-16 rounded-full bg-[radial-gradient(closest-side,rgba(251,191,36,0.22),transparent)] blur-xl" aria-hidden />
      </div>
      {controls}
    </div>
  );
}
