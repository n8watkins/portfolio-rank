"use client";

import { useState } from "react";
import { BellRing, CircleCheck, Copy, Download, Share2, Trophy } from "lucide-react";
import { EmailLink } from "@/components/grade/EmailLink";
import { btnSecondary } from "@/components/ui/styles";

/**
 * The report's actions, by weight: Share is the one primary action and the
 * PDF sits beside it (the browser's own "Save as PDF" on the print
 * stylesheet); below, a quieter row: the leaderboard (on it, or the request
 * to join the community list) and the report by email (a one-time link that
 * makes any browser its owner).
 */
export function ReportActions({
  id,
  domain,
  listed,
  joinHref,
  emailed,
  games,
}: {
  id: string;
  domain: string;
  /** The report is about a portfolio on the list. */
  listed: boolean;
  /** Where to ask for a place on the list (the community list's submission form). */
  joinHref: string;
  /** An email for this report is already on its way. */
  emailed: boolean;
  /** GAMES_V2: a share counts toward the badges. */
  games: boolean;
}) {
  const [shared, setShared] = useState<"idle" | "copied" | "shared">("idle");
  const [mailOpen, setMailOpen] = useState(false);

  const share = async () => {
    const url = `${location.origin}/grade/${encodeURIComponent(id)}`;
    let done: "copied" | "shared" | null = null;
    try {
      if (typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: `${domain} on PortfolioRank`, url });
        done = "shared";
      } else {
        await navigator.clipboard.writeText(url);
        done = "copied";
      }
    } catch {
      // A cancelled share sheet or a blocked clipboard: nothing happened.
    }
    if (!done) return;
    setShared(done);
    if (games) void fetch("/api/badges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "share" }) }).catch(() => {});
  };

  return (
    <div className="print:hidden">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={share} className="group btn-sheen inline-flex h-12 items-center gap-2 rounded-lg bg-fill px-6 text-[15px] font-semibold text-on-fill transition active:scale-[0.97]">
          {shared === "copied" ? <Copy className="h-4 w-4" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
          {shared === "copied" ? "Link copied" : shared === "shared" ? "Shared" : "Share your result"}
        </button>
        <button type="button" onClick={() => window.print()} className={`${btnSecondary} h-12`}>
          <Download className="h-4 w-4" aria-hidden /> Download PDF
        </button>
        <span role="status" className="sr-only">
          {shared === "copied" ? "The report's link is copied to the clipboard" : ""}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-2 border-t border-edge pt-4 sm:grid-cols-2">
        {listed ? (
          <p className="flex items-start gap-2.5 p-1 text-sm">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
            <span>
              <span className="block font-semibold">On the leaderboard</span>
              <span className="block text-mute">People vote on it in face-offs.</span>
            </span>
          </p>
        ) : (
          <a href={joinHref} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2.5 rounded-lg p-1 text-left text-sm hover:bg-raised">
            <Trophy className="icon-twinkle mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="block font-semibold text-accent">Add me to the leaderboard</span>
              <span className="block text-mute">People start voting on it. Leave any time.</span>
              <span className="sr-only">(opens GitHub in a new tab)</span>
            </span>
          </a>
        )}
        {emailed ? (
          <p className="flex items-start gap-2.5 p-1 text-sm" role="status">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
            <span>
              <span className="block font-semibold">Link on its way</span>
              <span className="block text-mute">Open it on any device to keep this report as yours.</span>
            </span>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setMailOpen((v) => !v)}
            aria-expanded={mailOpen}
            aria-controls="report-email"
            className="group flex items-start gap-2.5 rounded-lg p-1 text-left text-sm hover:bg-raised"
          >
            <BellRing className="icon-shake mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="block font-semibold text-accent">Email me the report</span>
              <span className="block text-mute">A one-time link that keeps it yours on any device.</span>
            </span>
          </button>
        )}
      </div>
      {mailOpen && !emailed && (
        <div id="report-email" className="mt-3">
          <EmailLink jobId={id} success="Done. Check your inbox for the link; it works once and for 7 days." />
        </div>
      )}
    </div>
  );
}
