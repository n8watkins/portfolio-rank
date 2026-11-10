"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, PanelRightOpen, X } from "lucide-react";
import { ScorecardPanel } from "@/components/preview/ScorecardPanel";
import type { Scorecard } from "@/lib/preview/data";

const VIEW_KEY = "pr-details-view";

type Props = {
  name: string;
  domain: string;
  url: string;
  shot: string;
  card: Scorecard;
  /** Hide the tier and 1-5 scores (quiz before guessing, face-off before voting). */
  hideScores?: boolean;
  hiddenWhy?: string;
  compact?: boolean;
  /** Open on load (screenshots). */
  initialOpen?: boolean;
  initialView?: "simple" | "advanced";
};

/** "Details": a large scrollable preview of the whole page plus its scorecard. */
export function Details({ name, domain, url, shot, card, hideScores = false, hiddenWhy, compact = false, initialOpen = false, initialView }: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [full, setFull] = useState(true);
  const ref = useRef<HTMLDialogElement>(null);


  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      document.documentElement.style.overflow = "hidden";
    }
    if (!open && d.open) d.close();
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);



  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-edge bg-card font-semibold text-ink shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-95 ${compact ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm"}`}
        aria-haspopup="dialog"
      >
        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden /> <span className={compact ? "max-sm:sr-only" : ""}>Details</span>
      </button>
      <dialog
        ref={ref}
        aria-label={`Details: ${name}`}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        className="details m-auto h-[100dvh] max-h-none w-full max-w-none bg-transparent p-0 text-ink backdrop:bg-black/60 backdrop:backdrop-blur-sm sm:h-[88vh] sm:w-[calc(100%-3rem)] sm:max-w-6xl"
      >
        <div className="flex h-full flex-col overflow-hidden bg-card sm:rounded-2xl sm:border sm:border-edge">
          <header className="flex items-center gap-3 border-b border-edge px-4 py-3 sm:px-5">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{name}</span>
              <span className="block truncate text-xs text-mute">{domain}</span>
            </span>
            <a href={url} target="_blank" rel="noopener noreferrer" className="group btn-sheen inline-flex h-9 items-center gap-1.5 rounded-lg bg-fill px-3 text-sm font-semibold text-on-fill">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Visit site
            </a>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* The whole page, scrollable */}
            <div className="min-h-0 overflow-y-auto border-edge bg-raised max-lg:h-[42vh] lg:border-r" tabIndex={0} aria-label="Full-page screenshot, scrollable">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={full ? `${shot}/full.jpg` : `${shot}/hero.jpg`}
                alt={`Full page of ${domain}`}
                onError={() => setFull(false)}
                className="block w-full"
              />
            </div>

            {/* The scorecard */}
            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              <ScorecardPanel card={card} hideScores={hideScores} hiddenWhy={hiddenWhy} initialView={initialView} />
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
