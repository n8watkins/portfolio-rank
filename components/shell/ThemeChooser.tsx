"use client";

import { THEMES, THEME_LABEL, useTheme } from "@/lib/theme";

/** System, Light and Dark as a radio group (the Settings page; the header menus have the same choice). */
export function ThemeChooser({ labelledBy, describedBy }: { labelledBy: string; describedBy?: string }) {
  const [theme, set] = useTheme();
  return (
    <div>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
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
