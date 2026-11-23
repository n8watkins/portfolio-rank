"use client";

import { useId, useRef, useState } from "react";
import { CircleCheck, Flag, LoaderCircle } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import { btnGhost, btnPrimary } from "@/components/ui/styles";
import { NOTE_MAX, REASONS, TURNSTILE_ACTION } from "@/lib/problem-reports/store.mjs";

// "Report a problem" under a profile's screenshot (owner, 2026-11-22): the
// screenshot and the measurements are taken by code, and sometimes the
// capture is wrong (a cookie wall, a loader, the wrong page). A visitor picks
// what is wrong, may add a short note, and sends it; the panel says thanks
// and the page stays where it was. POST /api/problem-reports
// (lib/problem-reports/intake.mjs); the owner reads them on /admin/review.
// A report changes nothing about the site by itself. Turnstile loads only
// once the panel opens.

const ERRORS: Record<string, string> = {
  rate_limited: "That's a lot of reports from here today. Try again tomorrow.",
  turnstile_failed: "We couldn't check that you're a person. Reload the page and try again.",
  note_too_long: `Keep the note under ${NOTE_MAX} characters.`,
  unknown_site: "We couldn't find this site any more. Reload the page.",
};

export function ReportProblem({ url, domain, className = "" }: { url: string; domain: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const token = useRef<string | null>(null);
  const widgetFailed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);
  const id = useId();

  const show = () => {
    prefetchTurnstile();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    // A sent report starts fresh next time; an unsent one keeps what was picked.
    if (sent) {
      setSent(false);
      setReason(null);
      setNote("");
    }
    setError(null);
  };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!reason) {
      setError("Pick what's wrong first.");
      document.getElementById(`${id}-reason-${REASONS[0].key}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    // The invisible check usually answers in well under a second; wait a little for it.
    for (let k = 0; k < 30 && !token.current && !widgetFailed.current; k++) await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch("/api/problem-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, reason, note: note.trim() || undefined, ...(token.current ? { turnstileToken: token.current } : {}) }),
      });
      token.current = null;
      widget.current?.reset();
      if (res.ok) {
        setSent(true);
        return;
      }
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERRORS[b.error ?? ""] ?? "That didn't send. Try again in a moment.");
    } catch {
      setError("We couldn't reach PortfolioRank. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const left = NOTE_MAX - [...note].length;

  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <p className="min-w-0 truncate text-xs text-mute">Taken automatically</p>
      <button
        type="button"
        onClick={show}
        onPointerEnter={prefetchTurnstile}
        aria-haspopup="dialog"
        className="-mr-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-mute transition hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-report-open
      >
        <Flag className="h-3.5 w-3.5" aria-hidden />
        Report a problem
      </button>

      <Modal
        open={open}
        onClose={close}
        title={sent ? "Thanks for telling us" : "Report a problem"}
        description={sent ? undefined : <>What looks wrong on {domain}&rsquo;s page? We read every report. A report doesn&rsquo;t change the site&rsquo;s rank by itself.</>}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        {sent ? (
          <div className="mt-3" role="status" data-report-thanks>
            <p className="flex items-start gap-2 text-sm text-pretty">
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
              <span>Your report is in. We&rsquo;ll look at {domain} and fix what the code got wrong.</span>
            </p>
            <div className="mt-5 flex justify-end">
              {/* Focused when the thanks appear, so a keyboard or screen-reader user lands on it. */}
              <button type="button" autoFocus onClick={close} className={btnPrimary} data-report-done>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={send} className="mt-4" noValidate>
            <fieldset aria-describedby={error ? `${id}-error` : undefined}>
              <legend className="text-sm font-semibold">What&rsquo;s wrong?</legend>
              <div className="mt-2 grid gap-1.5">
                {REASONS.map((r) => (
                  <label
                    key={r.key}
                    htmlFor={`${id}-reason-${r.key}`}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-edge px-3 py-2.5 transition hover:border-edge-strong has-[:checked]:border-accent/60 has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                  >
                    <input
                      id={`${id}-reason-${r.key}`}
                      type="radio"
                      name={`${id}-reason`}
                      value={r.key}
                      checked={reason === r.key}
                      onChange={() => {
                        setReason(r.key);
                        setError(null);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-fill)] focus-visible:outline-none"
                      data-report-reason={r.key}
                    />
                    <span className="min-w-0 text-sm leading-snug">
                      {r.label}
                      {r.hint && <span className="mt-0.5 block text-xs text-mute">{r.hint}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label htmlFor={`${id}-note`} className="mt-4 block text-sm font-semibold">
              Anything to add? <span className="font-normal text-mute">(optional)</span>
            </label>
            <textarea
              id={`${id}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={NOTE_MAX}
              aria-describedby={`${id}-count`}
              placeholder="What did you expect to see?"
              className="mt-1.5 block w-full resize-y rounded-lg border border-edge-strong bg-card px-3 py-2 text-[15px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)] outline-none transition placeholder:text-mute focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              data-report-note
            />
            <p id={`${id}-count`} className="mt-1 text-right text-xs tabular-nums text-mute" aria-live={left <= 50 ? "polite" : "off"}>
              {left} characters left
            </p>

            {error && (
              <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-down text-pretty" data-report-error>
                {error}
              </p>
            )}

            <Turnstile
              ref={widget}
              action={TURNSTILE_ACTION}
              onToken={(t) => (token.current = t)}
              onExpire={() => (token.current = null)}
              onError={() => (widgetFailed.current = true)}
              className="mt-2 empty:hidden"
            />

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={close} className={btnGhost}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={btnPrimary} data-report-send>
                {busy && <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                {busy ? "Sending..." : "Send report"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
