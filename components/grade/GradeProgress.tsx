"use client";

import { useState } from "react";
import { ArrowRight, CircleCheck, KeyRound, Mail, Swords } from "lucide-react";
import { EmailLink } from "@/components/grade/EmailLink";
import { FreeTierNote } from "@/components/grade/FreeTierNote";
import { STATE_WORD, useGradeJob, waitingLine } from "@/components/grade/useGradeJob";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import type { Job } from "@/lib/me";

type Step = Job["steps"][number];

function Dot({ state }: { state: Step["state"] }) {
  if (state === "done") return <CircleCheck className="h-5 w-5 shrink-0 text-up" aria-hidden />;
  if (state === "running" || state === "needs_key" || state === "waiting")
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
        <span className="attn-dot" />
      </span>
    );
  if (state === "failed" || state === "off")
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-down" />
      </span>
    );
  return <span className="h-5 w-5 shrink-0 rounded-full border-2 border-edge-strong" aria-hidden />;
}

/**
 * The progress page of a grade (/grade/<id> while it runs): the real steps
 * from GET /api/grade/<id>, kept live; "get it by email" (the main path when
 * the grade waits for tomorrow's share); the own-key step; and a face-off to
 * play meanwhile. The page turns into the report when the grade is done.
 */
export function GradeProgress({ job: initial, faceOff, faceOffHref }: { job: Job; faceOff: { url: string; domain: string; hero: string }[]; faceOffHref: string | null }) {
  const { job, finish, busy, keyError } = useGradeJob(initial);
  const [key, setKey] = useState("");
  const steps = job.steps;
  const done = steps.filter((s) => s.state === "done").length;
  const later = job.status === "waiting" || job.status === "queued";

  return (
    <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5 px-4 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby="grading" className="card rise p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">{later ? "In line" : "Grading"}</p>
        <h1 id="grading" className="mt-1 break-words text-2xl font-bold tracking-tight">
          {job.domain}
        </h1>
        <div
          className="mt-6 h-2 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-label="Grade progress"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.max(4, (100 * done) / steps.length)}%` }} />
        </div>
        <ol className="mt-6 grid grid-cols-1 gap-3 text-[15px]" aria-live="polite">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-3">
              <Dot state={s.state} />
              <span className={s.state === "running" || s.state === "needs_key" || s.state === "waiting" ? "font-semibold" : s.state === "pending" ? "text-mute" : ""}>
                {s.label}
              </span>
              <span className="sr-only">: {STATE_WORD[s.state] ?? s.state}</span>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-[15px] text-mute text-pretty">{waitingLine(job)}</p>

        {job.status === "awaiting_key" && (
          <form
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void finish({ geminiKey: key.trim() });
            }}
          >
            <label htmlFor="grade-key" className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <KeyRound className="h-4 w-4 text-mute" aria-hidden /> Your Gemini API key
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="grade-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="AIza..."
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-invalid={!!keyError}
                aria-describedby={keyError ? "grade-key-error" : "grade-key-help"}
                className="h-11 min-w-0 flex-1 rounded-lg border border-edge bg-card px-3 text-sm outline-none focus:border-accent"
              />
              <button type="submit" disabled={busy || !key.trim()} className={btnPrimary}>
                Finish the grade
              </button>
              <button type="button" disabled={busy} onClick={() => finish({ freeTier: true })} className={btnSecondary}>
                Use the free tier
              </button>
            </div>
            {keyError ? (
              <p id="grade-key-error" role="alert" className="mt-2 text-sm text-down">
                {keyError}
              </p>
            ) : (
              <p id="grade-key-help" className="mt-1 text-xs text-mute">
                Used once for this grade, on your quota. Never stored or logged.
              </p>
            )}
          </form>
        )}

        <FreeTierNote className="mt-6 border-t border-edge pt-5" />
      </section>

      <section aria-labelledby="by-email" className="card rise p-5 sm:p-6" style={{ "--d": "80ms" } as React.CSSProperties}>
        <h2 id="by-email" className="flex items-center gap-2 font-semibold">
          <Mail className="h-4 w-4 text-mute" aria-hidden /> {later ? "We'll email your report" : "Get it by email, no account needed"}
        </h2>
        {job.email.requested ? (
          <p className="mt-1 flex items-center gap-2 text-sm" role="status">
            <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden /> We&apos;ll email you the link when it&apos;s ready. You can close this page.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[15px] text-mute">
              {later ? "Leave your email and we send a one-time link to your report when it's ready." : "We send a one-time link to your report. You can close this page."}
            </p>
            <div className="mt-4">
              <EmailLink jobId={job.id} />
            </div>
          </>
        )}
      </section>

      {faceOffHref && faceOff.length === 2 && (
        <a href={faceOffHref} className="card card-hover rise group block p-5" style={{ "--d": "160ms" } as React.CSSProperties}>
          <span className="flex items-center gap-3">
            <span className="icon-tile h-10 w-10 shrink-0">
              <Swords className="icon-shake h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Vote in a face-off</span>
              <span className="block text-sm text-mute">Two portfolios. Pick the one you&apos;d hire from.</span>
            </span>
            <ArrowRight className="nudge h-4 w-4 text-mute" aria-hidden />
          </span>
          <span className="mt-4 grid grid-cols-2 gap-2">
            {faceOff.map((s, i) => (
              <span key={s.url} className="min-w-0">
                <ScreenshotFrame src={s.hero} alt="" domain={s.domain} className="w-full rounded-lg border border-edge" />
                <span className={`mt-1.5 block truncate text-xs text-mute ${i === 1 ? "text-right" : ""}`}>{s.domain}</span>
              </span>
            ))}
          </span>
        </a>
      )}
    </div>
  );
}
