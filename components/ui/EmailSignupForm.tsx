"use client";

import { useId, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

export type SignupResult = { ok: true } | { ok: false; error: string };

/**
 * An email field and its button (the newsletter sign-up, "email me my
 * report"). The input and the button are separate controls with their own
 * borders, never one bordered box: side by side when the form is at least
 * 24rem wide, stacked full width below that. It stacks by its own width (a
 * container query), so it fits a sidebar on a wide screen too.
 *
 * States: a visible focus ring on the input, the button disabled while it
 * sends ("Subscribing..."), an inline error under the field (kept input,
 * announced), and the success line in place of the form.
 */
export function EmailSignupForm({
  onSubmit,
  label = "Your email",
  button = "Subscribe",
  busyLabel = "Subscribing...",
  helper = "One email a week. No spam, unsubscribe in one click.",
  success = "Check your inbox to confirm. One email a week, unsubscribe any time.",
  className = "",
}: {
  /** Sends the address; resolve with ok, or an error to show under the field. */
  onSubmit: (email: string) => Promise<SignupResult>;
  label?: string;
  button?: string;
  busyLabel?: string;
  helper?: string;
  success?: string;
  className?: string;
}) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (state === "done")
    return (
      <p role="status" className={`pop-in flex items-start gap-2 rounded-xl border border-up/40 bg-up/10 p-4 text-sm font-medium ${className}`}>
        <CircleCheck className="mt-px h-5 w-5 shrink-0 text-up" aria-hidden /> {success}
      </p>
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError("Enter an email address like you@example.com.");
      return;
    }
    setError(null);
    setState("busy");
    try {
      const res = await onSubmit(value);
      if (res.ok) setState("done");
      else {
        setError(res.error);
        setState("idle");
      }
    } catch {
      setError("Couldn't reach the server. Your address is still here; try again.");
      setState("idle");
    }
  };

  const busy = state === "busy";
  return (
    <form noValidate onSubmit={submit} className={`@container ${className}`} aria-busy={busy}>
      <label htmlFor={`${id}-email`} className="text-sm font-medium">
        {label}
      </label>
      <div className="mt-1.5 flex flex-col gap-2 @sm:flex-row">
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
          aria-describedby={`${error ? `${id}-error ` : ""}${id}-help`}
          className="h-11 w-full min-w-0 rounded-lg border border-edge-strong bg-card px-3 text-[15px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.12)] outline-none transition placeholder:text-mute focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-invalid:border-down @sm:flex-1"
        />
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full shrink-0 @sm:w-auto`}>
          {busy && <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {busy ? busyLabel : button}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-down">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <p id={`${id}-help`} className="mt-2 text-xs text-mute">
        {helper}
      </p>
    </form>
  );
}
