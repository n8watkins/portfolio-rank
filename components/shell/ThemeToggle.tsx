"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { THEMES, THEME_LABEL, useTheme } from "@/lib/theme";

/** Cycles System, Light, Dark. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, set] = useTheme();
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button
      type="button"
      onClick={() => set(next)}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mute transition hover:bg-raised hover:text-ink ${className}`}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}

/** System, Light and Dark as a radio group (the phone More sheet). */
export function ThemeChooser() {
  const [theme, set] = useTheme();
  return (
    <div>
      <p id="theme-label" className="mb-2 px-1 text-xs font-medium text-mute">
        Theme
      </p>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="grid grid-cols-3 gap-1 rounded-lg bg-raised p-1"
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const t = THEMES[(THEMES.indexOf(theme) + step + THEMES.length) % THEMES.length];
          set(t);
          e.currentTarget.querySelector<HTMLElement>(`[data-theme-option="${t}"]`)?.focus();
        }}
      >
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            data-theme-option={t}
            aria-checked={theme === t}
            tabIndex={theme === t ? 0 : -1}
            onClick={() => set(t)}
            className="h-10 rounded-md text-sm font-medium text-mute transition aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-sm"
          >
            {THEME_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
