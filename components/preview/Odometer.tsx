"use client";

import { useEffect, useState } from "react";

/**
 * Rolling digits, like an odometer: each digit spins up from 0 to its value,
 * right to left with a short stagger, while the number fades in. Text that
 * isn't a number just fades in. Static under reduced motion.
 */
export function Odometer({ value, className = "" }: { value: string; className?: string }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setGo(true);
      return;
    }
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    return () => cancelAnimationFrame(t);
  }, []);
  const chars = [...value];
  const digits = chars.filter((c) => /\d/.test(c)).length;
  let seen = 0;
  return (
    <span className={`odo inline-flex items-baseline ${go ? "odo-on" : ""} ${className}`} aria-label={value}>
      {chars.map((c, i) => {
        if (!/\d/.test(c))
          return (
            <span key={i} aria-hidden>
              {c}
            </span>
          );
        const fromRight = digits - ++seen;
        return (
          <span key={i} className="relative inline-block h-[1.1em] overflow-hidden leading-[1.1em]" aria-hidden>
            <span
              className="odo-col flex flex-col"
              style={{
                transform: go ? `translateY(-${Number(c) * 10}%)` : "translateY(0)",
                transitionDelay: `${fromRight * 70}ms`,
              }}
            >
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d} className="h-[1.1em]">
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
