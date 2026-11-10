"use client";

import { useState } from "react";
import { Bookmark, BookmarkCheck, ExternalLink } from "lucide-react";

/**
 * Visit the real site (new tab) and save it to a list. Saving is mocked here;
 * the real app uses the existing lists (components/AddToListButton.tsx).
 */
export function SiteActions({ url, name, compact = false, onDark = false }: { url: string; name: string; compact?: boolean; onDark?: boolean }) {
  const [saved, setSaved] = useState(false);
  const base = onDark
    ? "border-white/25 bg-black/35 text-white backdrop-blur hover:bg-black/55"
    : "border-edge bg-card text-ink shadow-[var(--card-hi)] hover:border-edge-strong";
  const btn = `inline-flex items-center gap-1.5 rounded-lg border font-semibold transition ${compact ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm"} ${base}`;
  return (
    <span className="flex items-center gap-1.5">
      <a href={url} target="_blank" rel="noopener noreferrer" className={btn} aria-label={`Visit ${name} (opens in a new tab)`} onClick={(e) => e.stopPropagation()}>
        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> <span className={compact ? "max-sm:sr-only" : ""}>Visit</span>
      </a>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setSaved((s) => !s);
        }}
        aria-pressed={saved}
        aria-label={saved ? `Saved ${name} to Favorites` : `Save ${name} to a list`}
        className={btn}
      >
        {saved ? <BookmarkCheck className="pop-in h-3.5 w-3.5 text-accent" aria-hidden /> : <Bookmark className="h-3.5 w-3.5" aria-hidden />}
        <span className={compact ? "max-sm:sr-only" : ""}>{saved ? "Saved" : "Save"}</span>
      </button>
    </span>
  );
}
