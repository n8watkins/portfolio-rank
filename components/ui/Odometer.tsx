"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "@/components/ui/motion";

/**
 * A number with rolling digits, like an odometer: each digit spins up from 0
 * to its value, right to left with a short stagger, while the number fades
 * in. Text that isn't a digit just fades in. Static under reduced motion.
 * Screen readers get the value from the label, never the spinning columns.
 */
export function Odometer({ value, className = "" }: { value: string; className?: string }) {
  const reduced = useReducedMotion();
  const [started, setStarted] = useState(false);
  const go = started || reduced;
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setStarted(true))));
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  const chars = [...value];
  const digits = chars.filter((c) => /\d/.test(c)).length;
  let seen = 0;
  return (
    <span role="img" className={`odo inline-flex items-baseline ${go ? "odo-on" : ""} ${className}`} aria-label={value}>
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
