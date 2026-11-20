"use client";

import { useEffect, useRef } from "react";
import { SlidersHorizontal } from "lucide-react";
import { DETAILED, METRICS, SECTIONS, SIMPLE, type ViewPrefs } from "@/lib/play/view-prefs";

// Play's view switch: Simple (screenshot and Lighthouse performance) or
// Detailed (everything), plus a small "Show" menu of checkboxes for exactly
// which scores and sections appear. Remembered per viewer (lib/play/view-prefs.ts).

export function ViewControls({ prefs, choose, toggle }: { prefs: ViewPrefs; choose: (p: ViewPrefs) => void; toggle: (kind: "metrics" | "sections", id: string) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  // The menu closes on a click outside it and on Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu.current?.open) {
        // Closing the menu is all Escape does here (Play leaves it alone).
        e.preventDefault();
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const seg =
    "inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-mute transition hover:text-ink aria-pressed:bg-card aria-pressed:text-ink aria-pressed:shadow-[var(--card-hi),var(--card-drop)]";
  return (
    <div className="flex items-center gap-2">
      <div role="group" aria-label="How much to show" className="inline-flex rounded-lg border border-edge bg-raised p-0.5">
        <button type="button" aria-pressed={prefs.mode === "simple"} onClick={() => choose(SIMPLE)} className={seg}>
          Simple
        </button>
        <button type="button" aria-pressed={prefs.mode === "detailed"} onClick={() => choose(DETAILED)} className={seg}>
          Detailed
        </button>
      </div>
      <details ref={menu} className="relative">
        <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-edge px-3 text-sm font-semibold text-mute transition hover:text-ink [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal className="h-4 w-4" aria-hidden /> Show
          {prefs.mode === "custom" && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="(custom)" />}
        </summary>
        <div className="absolute right-0 z-30 mt-1.5 w-60 rounded-xl border border-edge bg-card p-3 shadow-[var(--card-hi),var(--card-drop)]">
          <fieldset>
            <legend className="text-xs font-semibold tracking-wider text-mute uppercase">Lighthouse</legend>
            <div className="mt-1.5 grid gap-0.5">
              {METRICS.map((m) => (
                <label key={m.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={prefs.metrics.includes(m.id)} onChange={() => toggle("metrics", m.id)} className="h-4 w-4 accent-[var(--color-fill)]" />
                  {m.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-2 border-t border-edge pt-2">
            <legend className="sr-only">Sections</legend>
            <div className="grid gap-0.5">
              {SECTIONS.map((s) => (
                <label key={s.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={prefs.sections.includes(s.id)} onChange={() => toggle("sections", s.id)} className="h-4 w-4 accent-[var(--color-fill)]" />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>
    </div>
  );
}
