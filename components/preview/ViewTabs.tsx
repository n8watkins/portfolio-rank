"use client";

import { useState } from "react";
import { Bot, Merge, Users } from "lucide-react";

export const VIEWS = [
  { key: "merged", label: "Merged", Icon: Merge },
  { key: "ai", label: "AI", Icon: Bot },
  { key: "people", label: "People", Icon: Users },
] as const;

export type ViewKey = (typeof VIEWS)[number]["key"];

/** Merged | AI | People, as real tabs with one panel each (home Top 10). */
export function ViewTabs({ panels, label }: { panels: Record<ViewKey, React.ReactNode>; label: string }) {
  const [view, setView] = useState<ViewKey>("merged");
  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="inline-flex rounded-lg bg-raised p-1"
        onKeyDown={(e) => {
          const i = VIEWS.findIndex((v) => v.key === view);
          const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!d) return;
          const next = VIEWS[(i + d + VIEWS.length) % VIEWS.length].key;
          setView(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {VIEWS.map(({ key, label: l, Icon }) => (
          <button
            key={key}
            id={`tab-${key}`}
            role="tab"
            type="button"
            aria-selected={view === key}
            aria-controls={`panel-${key}`}
            tabIndex={view === key ? 0 : -1}
            onClick={() => setView(key)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-mute transition aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-sm"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {l}
          </button>
        ))}
      </div>
      {VIEWS.map(({ key }) => (
        <div key={key} id={`panel-${key}`} role="tabpanel" aria-labelledby={`tab-${key}`} hidden={view !== key} className="mt-3">
          {panels[key]}
        </div>
      ))}
    </div>
  );
}
