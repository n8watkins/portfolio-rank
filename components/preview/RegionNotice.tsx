"use client";

import { useEffect, useState } from "react";
import { Globe, X } from "lucide-react";

const KEY = "pr-region-notice-dismissed";

/** Site-wide notice for visitors where AI grading is off; dismissed once per browser. */
export function RegionNotice({ country }: { country: string }) {
  // Shown in the server HTML; hidden after mount if dismissed before.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) setOpen(false);
    } catch {}
  }, []);
  if (!open) return null;
  return (
    <div role="region" aria-label="Notice about AI grading in your region" className="border-b border-edge bg-raised">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-3 sm:px-6">
        <span className="icon-tile mt-0.5 h-8 w-8 shrink-0">
          <Globe className="h-4 w-4" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm">
          <strong className="font-semibold">You&apos;re visiting from {country}, where AI grading is off.</strong>{" "}
          <span className="text-mute">
            It&apos;s off in the UK, the EU/EEA and Switzerland: PortfolioRank runs on Google Gemini&apos;s free tier, which Google doesn&apos;t allow for apps used in these
            regions. You can still browse, vote, play and read everything.
          </span>
        </p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            try {
              localStorage.setItem(KEY, "1");
            } catch {}
          }}
          aria-label="Dismiss notice"
          className="-m-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-mute transition hover:bg-card hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
