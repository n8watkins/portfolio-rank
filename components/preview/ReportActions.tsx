"use client";

import { useState } from "react";
import { CircleCheck, Mail, Share2, Trophy } from "lucide-react";
import { btnPrimary, btnSecondary } from "@/components/preview/bits";

/** Share, join the leaderboard, email updates (all mocked). */
export function ReportActions({ onBoard, subscribed }: { onBoard: boolean; subscribed: boolean }) {
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState(onBoard);
  const [mail, setMail] = useState(subscribed);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <button
        type="button"
        className={btnPrimary}
        onClick={() => {
          navigator.clipboard?.writeText(location.href.split("?")[0]).catch(() => {});
          setCopied(true);
        }}
      >
        {copied ? <CircleCheck className="h-4 w-4" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
        {copied ? "Link copied" : "Share report"}
      </button>
      {joined ? (
        <span className={`${btnSecondary} pointer-events-none text-up`} role="status">
          <CircleCheck className="h-4 w-4" aria-hidden /> On the leaderboard
        </span>
      ) : (
        <button type="button" className={btnSecondary} onClick={() => setJoined(true)}>
          <Trophy className="h-4 w-4" aria-hidden /> Add me to the leaderboard
        </button>
      )}
      {mail ? (
        <span className={`${btnSecondary} pointer-events-none text-mute`} role="status">
          <CircleCheck className="h-4 w-4" aria-hidden /> Emailing you updates
        </span>
      ) : (
        <button type="button" className={btnSecondary} onClick={() => setMail(true)}>
          <Mail className="h-4 w-4" aria-hidden /> Email me updates
        </button>
      )}
    </div>
  );
}
