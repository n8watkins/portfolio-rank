"use client";

import { useEffect } from "react";
import { FlaskConical } from "lucide-react";
import { useTheme, type Theme } from "@/components/shell/ThemeToggle";

const STATES: [string, string][] = [
  ["first", "First visit"],
  ["returning", "Graded before"],
  ["listed", "Signed in, listed"],
  ["unlisted", "Signed in, not listed"],
  ["queued", "Report queued"],
];
const COOKIE = "pr-preview-state";

/** Preview-only: switch the visitor state and theme. Not part of the design. */
export function PreviewBar({ state }: { state: string }) {
  const [theme, setTheme] = useTheme();

  // A ?state= link is remembered, so every page keeps that visitor.
  useEffect(() => {
    document.cookie = `${COOKIE}=${state}; path=/; max-age=31536000; samesite=lax`;
  }, [state]);

  const select =
    "h-7 rounded-md border border-sample/40 bg-transparent px-1.5 text-xs font-medium text-ink outline-none focus-visible:border-sample";
  return (
    <div className="border-b border-sample/30 bg-sample/10">
      <div className="mx-auto flex max-w-6xl items-center gap-x-3 sm:gap-x-4 px-4 py-1.5 text-xs sm:px-6">
        <p className="flex items-center gap-1.5 font-semibold text-sample">
          <FlaskConical className="h-3.5 w-3.5" aria-hidden />
          Preview
          <span className="hidden font-normal text-mute md:inline">Sample data is marked. Not deployed.</span>
        </p>
        <label className="flex items-center gap-1.5 text-mute">
          <span className="sr-only sm:not-sr-only">Visitor</span>
          <select
            className={select}
            value={state}
            onChange={(e) => {
              const u = new URL(location.href);
              u.searchParams.set("state", e.target.value);
              location.href = u.toString();
            }}
          >
            {STATES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-mute">
          <span className="sr-only sm:not-sr-only">Theme</span>
          <select className={select} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
    </div>
  );
}
