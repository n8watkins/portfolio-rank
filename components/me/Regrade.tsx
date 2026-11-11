"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, RefreshCw, ScanSearch } from "lucide-react";
import { FreeTierNote } from "@/components/grade/FreeTierNote";
import { reportHref, useGradeRequest } from "@/components/grade/useGradeRequest";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

/**
 * Re-grade (POST /api/grade again): open once a week, or sooner when the
 * site changed since the last grade (the server compares the page's
 * fingerprint and says no when nothing changed).
 */
export function Regrade({
  url,
  gradedAt,
  regradeAfter,
  cooldownDays,
  now,
  follow = false,
}: {
  url: string;
  gradedAt: string;
  regradeAfter: string | null;
  /** pipeline/budget.mjs REGRADE_COOLDOWN_DAYS */
  cooldownDays: number;
  now: number;
  /** Go to the new grade's page once it starts (the report page); else refresh in place (/me). */
  follow?: boolean;
}) {
  const router = useRouter();
  const { arm, submit, busy, turnstile } = useGradeRequest();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // `now` is the server's render time, so the server and the browser agree.
  const open = !regradeAfter || Date.parse(regradeAfter) <= now;
  const left = regradeAfter && !open ? Math.max(1, Math.ceil((Date.parse(regradeAfter) - now) / 86_400_000)) : 0;

  const go = async () => {
    setNote(null);
    const r = await submit(url);
    if (follow && r.ok) return router.push(reportHref(r.id));
    if (follow && !r.ok && r.report) return router.push(reportHref(r.report));
    if (r.ok || r.error === "in_progress") return router.refresh();
    if (r.error === "cooldown")
      return setNote({ ok: false, text: `No changes found since the last grade. ${r.nextAt ? `The next re-grade opens ${day(r.nextAt)}.` : ""}`.trim() });
    setNote({ ok: false, text: r.message });
  };

  return (
    <div id="regrade" className="rounded-xl border border-edge bg-bg/40 p-4" onFocus={arm} onPointerEnter={arm}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Clock className="h-4 w-4 text-mute" aria-hidden /> Graded {day(gradedAt)}
      </p>
      {open ? (
        <>
          <p className="mt-1 text-sm text-mute">A fresh grade looks at your site as it is today.</p>
          <button type="button" disabled={busy} onClick={go} className={`${btnPrimary} mt-3 w-full`}>
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden /> Request a re-grade
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-mute">
            Grades refresh on request, once every {cooldownDays} days. Next re-grade available in {left} {left === 1 ? "day" : "days"}.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" disabled className={`${btnSecondary} w-full`}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Request a re-grade
            </button>
            <button
              type="button"
              onClick={go}
              disabled={busy}
              className="group inline-flex h-11 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-mute transition hover:text-ink"
            >
              <ScanSearch className="icon-twinkle h-4 w-4" aria-hidden />
              {busy ? "Checking your site..." : "Changed your site? Check now"}
            </button>
          </div>
        </>
      )}
      {note && (
        <p role="status" className={`mt-2 text-sm ${note.ok ? "text-up" : "text-mute"}`}>
          {note.text}
        </p>
      )}
      {turnstile}
      <FreeTierNote className="mt-3 border-t border-edge pt-3" />
    </div>
  );
}
