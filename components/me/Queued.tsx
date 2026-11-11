"use client";

import { useState } from "react";
import { CircleAlert, CircleCheck, Clock, KeyRound, Swords } from "lucide-react";
import { EmailLink } from "@/components/grade/EmailLink";
import { STATE_WORD, useGradeJob, waitingLine } from "@/components/grade/useGradeJob";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ROUTES } from "@/lib/nav";
import type { Job } from "@/lib/me";

function StepIcon({ state }: { state: Job["steps"][number]["state"] }) {
  if (state === "done") return <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />;
  if (state === "failed" || state === "off") return <CircleAlert className="h-4 w-4 shrink-0 text-down" aria-hidden />;
  if (state === "pending")
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
        <span className="h-2 w-2 rounded-full bg-edge-strong" />
      </span>
    );
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
      <span className="attn-dot" />
    </span>
  );
}

/**
 * A grade on its way (/me): the real steps, refreshed every few seconds;
 * the page reloads with the report once it's done. "Get it by email" for
 * waits that last until tomorrow, and the own-key step when the grade runs
 * on the visitor's key.
 */
export function Queued({ job: initial }: { job: Job }) {
  const { job, finish, busy, keyError } = useGradeJob(initial);
  const [key, setKey] = useState("");
  const steps = job.steps;
  const done = steps.filter((s) => s.state === "done").length;
  const later = job.status === "waiting" || job.status === "queued";

  return (
    <section aria-labelledby="queued" className="card flex w-full flex-col p-5 sm:p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-mute">Your report</p>
      <h1 id="queued" className="mt-1 text-xl font-bold tracking-tight text-balance">
        Your report on {job.domain} is being prepared
      </h1>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label="Report progress"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.max(8, (100 * done) / steps.length)}%` }} />
      </div>
      <ol className="mt-4 grid grid-cols-1 gap-2 text-sm" aria-live="polite">
        {steps.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <StepIcon state={s.state} />
            <span className={s.state === "running" || s.state === "needs_key" ? "font-semibold" : s.state === "pending" ? "text-mute" : ""}>{s.label}</span>
            <span className="sr-only">: {STATE_WORD[s.state] ?? s.state}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-raised p-3.5 text-sm">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
        <p>
          {waitingLine(job)}{" "}
          {job.email.requested ? (
            <>
              <strong>We&apos;ll email you</strong> when it&apos;s ready. You can close this page.
            </>
          ) : later ? (
            "Leave your email and we send the link when it's ready."
          ) : (
            "You can leave this page open, or come back to it later."
          )}
        </p>
      </div>

      {job.status === "awaiting_key" && (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void finish({ geminiKey: key.trim() });
          }}
        >
          <label htmlFor="me-key" className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
            <KeyRound className="h-4 w-4 text-mute" aria-hidden /> Your Gemini API key
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="me-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-invalid={!!keyError}
              aria-describedby={keyError ? "me-key-error" : "me-key-help"}
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
            <p id="me-key-error" role="alert" className="mt-2 text-sm text-down">
              {keyError}
            </p>
          ) : (
            <p id="me-key-help" className="mt-1 text-xs text-mute">
              Used once for this grade, on your quota. Never stored or logged.
            </p>
          )}
        </form>
      )}

      {later && !job.email.requested && (
        <div className="mt-4">
          <EmailLink jobId={job.id} label="Email me the report" button="Email me" />
        </div>
      )}

      {ROUTES.faceoff && (
        <div className="mt-auto flex flex-wrap gap-2 pt-4">
          <a href={ROUTES.faceoff} className={btnSecondary}>
            <Swords className="icon-shake h-4 w-4" aria-hidden /> Vote in a face-off meanwhile
          </a>
        </div>
      )}
    </section>
  );
}
