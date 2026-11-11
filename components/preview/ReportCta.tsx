"use client";

import { useState } from "react";
import { BellRing, CircleCheck, Copy, Share2, Trophy } from "lucide-react";
import { DownloadReport } from "@/components/preview/DownloadReport";

/**
 * The report's actions, by weight: Share is the one primary action, the PDF
 * sits beside it, and "keep it moving" (leaderboard, updates) is a quieter
 * row below with a line on what each does.
 */
export function ReportCta({
  onBoard,
  subscribed,
  signedIn,
  domain,
  reportHref,
  pdfOpen = false,
}: {
  onBoard: boolean;
  subscribed: boolean;
  signedIn: boolean;
  domain: string;
  reportHref: string;
  pdfOpen?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState(onBoard);
  const [mail, setMail] = useState(subscribed);
  return (
    <div className="print:hidden">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(location.href.split("?")[0]).catch(() => {});
            setCopied(true);
          }}
          className="group btn-sheen sheen-auto inline-flex h-12 items-center gap-2 rounded-lg px-6 text-[15px] font-semibold"
        >
          {copied ? <Copy className="h-4 w-4" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
          {copied ? "Link copied" : "Share your result"}
        </button>
        <DownloadReport signedIn={signedIn} domain={domain} reportHref={reportHref} initialOpen={pdfOpen} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 border-t border-edge pt-4 sm:grid-cols-2">
        {joined ? (
          <p className="flex items-start gap-2.5 text-sm" role="status">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
            <span>
              <span className="block font-semibold">On the leaderboard</span>
              <span className="block text-mute">People vote on it in face-offs.</span>
            </span>
          </p>
        ) : (
          <button type="button" onClick={() => setJoined(true)} className="group flex items-start gap-2.5 rounded-lg p-1 text-left text-sm hover:bg-raised">
            <Trophy className="icon-twinkle mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="block font-semibold text-accent">Add me to the leaderboard</span>
              <span className="block text-mute">People start voting on it. Leave any time.</span>
            </span>
          </button>
        )}
        {mail ? (
          <p className="flex items-start gap-2.5 text-sm" role="status">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
            <span>
              <span className="block font-semibold">Emailing you updates</span>
              <span className="block text-mute">When your rank moves or a re-grade is ready.</span>
            </span>
          </p>
        ) : (
          <button type="button" onClick={() => setMail(true)} className="group flex items-start gap-2.5 rounded-lg p-1 text-left text-sm hover:bg-raised">
            <BellRing className="icon-shake mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="block font-semibold text-accent">Email me updates</span>
              <span className="block text-mute">When your rank moves or a re-grade is ready.</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
