"use client";

import { Bookmark, ExternalLink, PanelRightOpen } from "lucide-react";
import { AddToListButton } from "@/components/AddToListButton";
import { profilePath } from "@/lib/profile-url.mjs";

// Details, Visit and Save under a portfolio in the games. Details opens the
// portfolio's page (its report) in a new tab, so a game in progress stays;
// Save uses the real lists (components/AddToListButton.tsx). `compact`
// (face-off cards on a phone) shows the icons only, each still named.

const btn = (compact: boolean) =>
  `inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge bg-card font-semibold text-ink shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97] ${
    compact ? "h-9 w-9 text-xs sm:h-8 sm:w-auto sm:px-2.5" : "h-10 px-3 text-sm sm:h-9"
  }`;
const label = (compact: boolean) => (compact ? "max-sm:sr-only" : "");

export function SiteActions({
  url,
  name,
  details = true,
  compact = false,
  onSaved,
}: {
  url: string;
  name: string;
  /** Hide Details (the quiz before a guess: the report shows the answer). */
  details?: boolean;
  compact?: boolean;
  /** After the Save dialog opens (a badge may follow). */
  onSaved?: () => void;
}) {
  return (
    <div className={`flex items-center ${compact ? "gap-1 sm:gap-1.5" : "gap-1.5"}`}>
      {details && (
        <a href={profilePath(url)} target="_blank" rel="noopener" className={btn(compact)} aria-label={`Details for ${name} (opens in a new tab)`}>
          <PanelRightOpen className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className={label(compact)}>Details</span>
        </a>
      )}
      <a href={url} target="_blank" rel="noopener noreferrer" className={btn(compact)} aria-label={`Visit ${name} (opens in a new tab)`}>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className={label(compact)}>Visit</span>
      </a>
      <div onClickCapture={onSaved} className="contents">
        <AddToListButton url={url} buttonClassName={btn(compact)} ariaLabel={`Save ${name} to a list`}>
          <Bookmark className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className={label(compact)}>Save</span>
        </AddToListButton>
      </div>
    </div>
  );
}
