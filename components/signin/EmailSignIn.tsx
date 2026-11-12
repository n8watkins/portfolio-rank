"use client";

import { useId, useRef, useState } from "react";
import { CircleAlert, MailCheck } from "lucide-react";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";

/**
 * Email sign-in in the sign-in dialog (components/SignInModal): an address,
 * then POST /api/signin/email sends a one-time link that works for 15
 * minutes. Turnstile loads on first focus and stays invisible for most
 * people. After sending, the form becomes "Check your email" with the
 * address and a way to use another one; the input is kept on any error.
 */
export function EmailSignIn({ callbackUrl, onSent }: { callbackUrl: string; onSent?: (sent: boolean) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const failed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);
  const [armed, setArmed] = useState(false);
  const arm = () => {
    if (armed) return;
    prefetchTurnstile();
    setArmed(true);
  };

  if (state === "sent")
    return (
      <div role="status" className="pop-in rounded-xl border border-up/40 bg-up/10 p-4 text-left">
        <p className="flex items-center gap-2 font-semibold">
          <MailCheck className="h-5 w-5 shrink-0 text-up" aria-hidden /> Check your email
        </p>
        <p className="mt-1 text-sm text-mute">
          We sent a sign-in link to <span className="font-medium text-ink">{email.trim()}</span>. It works once, for 15 minutes. You can close this window.
        </p>
        <button
          type="button"
          onClick={() => {
            setState("idle");
            onSent?.(false);
          }}
          className="mt-2 min-h-11 text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    arm();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError("Enter an email address like you@example.com.");
      return;
    }
    setError(null);
    setState("busy");
    for (let k = 0; k < 30 && !token.current && !failed.current; k++) await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch("/api/signin/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: value, callbackUrl, ...(token.current ? { turnstileToken: token.current } : {}) }),
      });
      token.current = null;
      widget.current?.reset();
      if (res.ok) {
        setState("sent");
        onSent?.(true);
        return;
      }
      const b = await res.json().catch(() => ({}));
      setError(
        b.error === "bad_email"
          ? "Enter an email address like you@example.com."
          : b.error === "rate_limited"
            ? "That's a lot of links for now. Check your inbox for the last one, or try again in an hour."
            : b.error === "turnstile_failed"
              ? "We couldn't check that this is a person. Reload the page and try again."
              : b.error === "email_unavailable"
                ? "We can't send email right now. Try again later, or continue with GitHub."
                : "That didn't work. Try again in a moment."
      );
    } catch {
      setError("We couldn't reach PortfolioRank. Check your connection; your address is still here.");
    }
    setState("idle");
  };

  const busy = state === "busy";
  return (
    <form noValidate onSubmit={submit} onFocus={arm} onPointerEnter={arm} className="text-left" aria-busy={busy}>
      <label htmlFor={`${id}-email`} className="sr-only">
        Email address
      </label>
      <input
        id={`${id}-email`}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (error) setError(null);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="h-11 w-full rounded-lg border border-edge-strong bg-card px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-sm text-down">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-edge-strong bg-card px-4 py-2.5 text-sm font-semibold transition hover:border-accent/60 disabled:opacity-60"
      >
        {busy ? "Sending..." : "Email me a sign-in link"}
      </button>
      {armed && (
        <Turnstile
          ref={widget}
          action="signin-email"
          onToken={(t) => (token.current = t)}
          onExpire={() => (token.current = null)}
          onError={() => (failed.current = true)}
          className="mt-2 empty:hidden"
        />
      )}
    </form>
  );
}
