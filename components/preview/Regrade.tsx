"use client";

import { useState } from "react";
import { CircleCheck, Clock, RefreshCw, ScanSearch } from "lucide-react";
import { btnPrimary, btnSecondary } from "@/components/preview/bits";
import { FreeTierNote } from "@/components/preview/FreeTierNote";

/**
 * Re-grade with a cooldown (mocked). Grades refresh on request, at most once
 * a week, or sooner when we detect the site changed.
 */
export function Regrade({ gradedOn }: { gradedOn: string }) {
  const [phase, setPhase] = useState<"cooldown" | "checking" | "changed" | "queued">("cooldown");
  return (
    <div id="regrade" className="rounded-xl border border-edge bg-bg/40 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Clock className="h-4 w-4 text-mute" aria-hidden /> Graded {gradedOn}
      </p>
      {phase === "queued" ? (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm">
          <span className="attn-dot" aria-hidden /> Re-grade queued. We&apos;ll email you when it&apos;s ready.
        </p>
      ) : phase === "changed" ? (
        <>
          <p role="status" className="mt-2 flex items-center gap-1.5 text-sm text-up">
            <CircleCheck className="h-4 w-4" aria-hidden /> Your site changed since the last grade.
          </p>
          <button type="button" className={`${btnPrimary} mt-3 w-full`} onClick={() => setPhase("queued")}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Request a re-grade
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-mute">Grades refresh on request, once a week. Next re-grade available in 6 days.</p>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" disabled className={`${btnSecondary} w-full cursor-not-allowed opacity-55`}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Request a re-grade
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("checking");
                setTimeout(() => setPhase("changed"), 1200);
              }}
              disabled={phase === "checking"}
              className="group inline-flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-mute transition hover:text-ink"
            >
              <ScanSearch className="icon-twinkle h-4 w-4" aria-hidden />
              {phase === "checking" ? "Checking your site..." : "Changed your site? Check now"}
            </button>
          </div>
        </>
      )}
      <FreeTierNote className="mt-3 border-t border-edge pt-3" />
    </div>
  );
}
