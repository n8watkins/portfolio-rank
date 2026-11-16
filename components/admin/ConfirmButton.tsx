"use client";

import { useEffect, useId, useRef, useState } from "react";

// A decision button that asks first (owner, 2026-11-14: a "Mark checked"
// pressed by accident applied at once). The first click arms it: the label
// turns into the question ("Confirm: mark checked?") in the warning style for
// ARMED_MS, and a second click acts. Esc, moving focus away or the time
// running out disarms it. Focus stays on the same button the whole time, so
// a keyboard user presses Enter twice; a screen reader hears the question
// through the button's own label and a polite live note. Never the browser's
// confirm(), which a phone can't style and a tester can't see.

export const ARMED_MS = 5000;

export function ConfirmButton({
  label,
  question,
  icon,
  className,
  armedClassName = "",
  disabled = false,
  target,
  onConfirm,
  ...rest
}: {
  /** What it acts on, for screen readers when many such buttons share a page ("Undo: example.dev"). */
  target?: string;
  /** What the button says at rest ("Mark checked"). */
  label: string;
  /** What it asks once armed ("Confirm: mark checked?"). */
  question: string;
  icon?: React.ReactNode;
  className: string;
  /** Extra classes while armed (the warning look). */
  armedClassName?: string;
  disabled?: boolean;
  onConfirm: () => void;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const note = useId();

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${className} ${armed ? `ring-2 ring-down/60 ${armedClassName}` : ""}`}
        disabled={disabled}
        aria-describedby={armed ? note : undefined}
        aria-label={target ? `${armed ? question : label} (${target})` : undefined}
        data-armed={armed ? "true" : "false"}
        onClick={() => {
          if (!armed) return setArmed(true);
          setArmed(false);
          onConfirm();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && armed) {
            // Disarm only: inside the screenshot viewer, Esc must not also close it.
            e.preventDefault();
            e.stopPropagation();
            setArmed(false);
          }
        }}
        onBlur={() => setArmed(false)}
        {...rest}
      >
        {icon}
        {armed ? question : label}
      </button>
      <span id={note} className="sr-only" aria-live="polite">
        {armed ? "Press again to confirm, or Escape to cancel." : ""}
      </span>
    </>
  );
}
