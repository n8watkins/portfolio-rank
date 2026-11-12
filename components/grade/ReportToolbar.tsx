"use client";

import { useState } from "react";
import { BellRing, CircleCheck, Copy, Download, Share2, Trophy } from "lucide-react";
import { EmailLink } from "@/components/grade/EmailLink";

/**
 * The report's actions in one small row (never printed): share the link,
 * download the PDF (the browser's own print on the print styles), get the
 * report by email (a one-time link that makes any browser its owner), and,
 * for a site not on the list, the request to join it.
 */
export function ReportToolbar({ id, domain, listed, joinHref, emailed, games }: { id: string; domain: string; listed: boolean; joinHref: string; emailed: boolean; games: boolean }) {
  const [shared, setShared] = useState<"idle" | "copied" | "shared">("idle");
  const [mailOpen, setMailOpen] = useState(false);
  const small = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-[13px] font-semibold transition hover:border-edge-strong active:scale-[0.97]";

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
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={share} className="btn-sheen inline-flex h-9 items-center gap-1.5 rounded-lg bg-fill px-3.5 text-[13px] font-semibold text-on-fill transition active:scale-[0.97]">
          {shared === "copied" ? <Copy className="h-3.5 w-3.5" aria-hidden /> : <Share2 className="h-3.5 w-3.5" aria-hidden />}
          {shared === "copied" ? "Link copied" : shared === "shared" ? "Shared" : "Share"}
        </button>
        <button type="button" onClick={() => window.print()} className={small}>
          <Download className="h-3.5 w-3.5" aria-hidden /> PDF
        </button>
        {emailed ? (
          <span role="status" className="inline-flex h-9 items-center gap-1.5 px-1 text-[13px] text-mute">
            <CircleCheck className="h-3.5 w-3.5 text-up" aria-hidden /> Email link on its way
          </span>
        ) : (
          <button type="button" onClick={() => setMailOpen((v) => !v)} aria-expanded={mailOpen} aria-controls="report-email" className={small}>
            <BellRing className="h-3.5 w-3.5" aria-hidden /> Email it to me
          </button>
        )}
        {listed && (
          <span className="inline-flex h-9 items-center gap-1.5 px-1 text-[13px] text-mute">
            <CircleCheck className="h-3.5 w-3.5 text-up" aria-hidden /> On the leaderboard
          </span>
        )}
        {!listed && (
          <a href={joinHref} target="_blank" rel="noopener noreferrer" className={`${small} text-accent`}>
            <Trophy className="h-3.5 w-3.5" aria-hidden /> Add me to the leaderboard<span className="sr-only"> (opens GitHub in a new tab)</span>
          </a>
        )}
        <span role="status" className="sr-only">
          {shared === "copied" ? "The report's link is copied to the clipboard" : ""}
        </span>
      </div>
      {mailOpen && !emailed && (
        <div id="report-email" className="mt-3 max-w-md">
          <EmailLink jobId={id} success="Done. Check your inbox for the link; it works once and for 7 days." />
        </div>
      )}
    </div>
  );
}
