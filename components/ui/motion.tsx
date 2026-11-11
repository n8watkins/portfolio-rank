"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// Shared motion helpers. The CSS side lives in app/globals.css ("motion"):
// `.rise` (entrance, stagger with style={{ "--d": "80ms" }}), `.reveal`
// (on scroll, components/ui/RevealObserver.tsx), `.nudge` / `.nudge-up`,
// `.icon-shake` / `.icon-twinkle` (inside a `.group`), `.pop-in`,
// `.bar-fill`, `.deal-in`, `.win-pop`, `.lose-dim`, `.attn-dot` and
// `.sheen-auto`. Every one of them stops under prefers-reduced-motion.

const REDUCE = "(prefers-reduced-motion: reduce)";
function subscribeMotion(onChange: () => void) {
  const q = window.matchMedia(REDUCE);
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
}

/** True when the visitor asked for less motion (false while rendering on the server). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCE).matches,
    () => false
  );
}

/** Counts 0 up to `target` whenever `key` changes; instant under reduced motion. */
export function useCountUp(target: number, key: unknown, ms = 700): number {
  const reduced = useReducedMotion();
  const [n, setN] = useState(target);
  useEffect(() => {
    if (reduced) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, target, ms, reduced]);
  return reduced ? target : n;
}

/** A short burst of sparks and a ring around its child; nothing under reduced motion. */
export function Burst({ children, on }: { children: React.ReactNode; on: boolean }) {
  return (
    <span className="burst">
      {on && <span className="ring" aria-hidden />}
      {on &&
        Array.from({ length: 8 }, (_, k) => (
          <span
            key={k}
            className="spark"
            style={{ "--a": `${k * 45}deg`, animationDelay: `${(k % 2) * 40}ms` } as React.CSSProperties}
            aria-hidden
          />
        ))}
      {children}
    </span>
  );
}
