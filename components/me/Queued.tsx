"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Clock, KeyRound, Swords } from "lucide-react";
import { EmailSignupForm } from "@/components/ui/EmailSignupForm";
import { Turnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";
import { ownKeySlot } from "@/components/grade/useGradeRequest";
import { ROUTES } from "@/lib/nav";
import type { Job } from "@/lib/me";

const ACTIVE = new Set(["capturing", "waiting", "grading", "queued", "awaiting_key"]);
const EVERY = 4000;

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

const STATE_WORD: Record<string, string> = {
  done: "done",
  running: "in progress",
  waiting: "waiting",
  pending: "not started",
  needs_key: "needs your key",
  failed: "failed",
  off: "not available",
};

/** What the visitor is waiting for, in one line. */
function why(job: Job): string {
  switch (job.status) {
    case "waiting":
      return job.reason ?? "Today's grading is full, so yours starts tomorrow.";
    case "queued":
      return "Today's AI grading is used up, so yours is first in line tomorrow morning.";
    case "grading":
      return "Gemini is looking at your page now. This takes about a minute.";
    case "awaiting_key":
      return "The screenshot is ready. Your Gemini key finishes the grade.";
    default:
      return "Opening your page and taking screenshots. This takes a minute or two.";
  }
}

/**
 * A grade on its way (/me): the real steps, refreshed every few seconds;
 * the page reloads with the report once it's done. "Get it by email" for
 * waits that last until tomorrow, and the own-key step when the grade runs
 * on the visitor's key.
 */
export function Queued({ job: initial }: { job: Job }) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);
  const widget = useRef<TurnstileHandle>(null);
  const [emailArmed, setEmailArmed] = useState(false);

  useEffect(() => {
    if (!ACTIVE.has(job.status)) {
      router.refresh();
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/grade/${job.id}`, { cache: "no-store" });
        if (res.ok) setJob(await res.json());
        else if (res.status === 404) router.refresh();
      } catch {}
    }, EVERY);
    return () => clearTimeout(t);
  }, [job, router]);

  const finish = async (body: Record<string, unknown>) => {
    setBusy(true);
    setKeyError("");
    try {
      const res = await fetch(`/api/grade/${job.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      if (res.ok) {
        try {
          sessionStorage.removeItem(ownKeySlot(job.id));
        } catch {}
        setJob(b as Job);
      } else setKeyError(typeof b.message === "string" ? b.message : "Gemini didn't accept that key. Check it, or use the free tier.");
    } catch {
      setKeyError("We couldn't reach PortfolioRank. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  // The key the visitor gave on the grade form, kept in this tab for its one use.
  const sent = useRef(false);
  useEffect(() => {
    if (job.status !== "awaiting_key" || sent.current) return;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(ownKeySlot(job.id));
    } catch {}
    if (stored) {
      sent.current = true;
      void finish({ geminiKey: stored });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status, job.id]);

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
          {why(job)}{" "}
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
        <div className="mt-4" onFocus={() => setEmailArmed(true)} onPointerEnter={() => setEmailArmed(true)}>
          <EmailSignupForm
            label="Email me the report"
            button="Email me"
            busyLabel="Saving..."
            helper="Only for this report. We erase the address once the email is sent."
            success="Done. We'll email you the link when your report is ready."
            onSubmit={async (email) => {
              for (let k = 0; k < 30 && emailArmed && !token.current; k++) await new Promise((r) => setTimeout(r, 150));
              try {
                const res = await fetch(`/api/grade/${job.id}/email`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email, ...(token.current ? { turnstileToken: token.current } : {}) }),
                });
                token.current = null;
                widget.current?.reset();
                if (res.ok) return { ok: true };
                const b = await res.json().catch(() => ({}));
                return {
                  ok: false,
                  error:
                    b.error === "bad_email"
                      ? "Enter an email address like you@example.com."
                      : b.error === "unavailable"
                        ? "Email isn't available right now. Keep this page and come back later."
                        : "That didn't work. Try again in a moment.",
                };
              } catch {
                return { ok: false, error: "We couldn't reach PortfolioRank. Check your connection and try again." };
              }
            }}
          />
          {emailArmed && <Turnstile ref={widget} action="grade-email" onToken={(t) => (token.current = t)} onExpire={() => (token.current = null)} className="empty:hidden" />}
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
