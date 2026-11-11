"use client";

import { useRef, useState } from "react";
import { EmailSignupForm } from "@/components/ui/EmailSignupForm";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";

/**
 * "Get it by email": POST /api/grade/<id>/email. The one-time link goes out
 * when the report is ready (at once for a finished one); opening it makes
 * that browser the report's owner. The address is erased once the email is
 * sent. Turnstile loads on first use.
 */
export function EmailLink({
  jobId,
  label = "Your email",
  button = "Email me the link",
  helper = "Only for this report. We erase the address once the email is sent.",
  success = "Done. We'll email you the link when your report is ready.",
}: {
  jobId: string;
  label?: string;
  button?: string;
  helper?: string;
  success?: string;
}) {
  const token = useRef<string | null>(null);
  const failed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);
  const [armed, setArmed] = useState(false);
  const arm = () => {
    if (armed) return;
    prefetchTurnstile();
    setArmed(true);
  };

  return (
    <div onFocus={arm} onPointerEnter={arm}>
      <EmailSignupForm
        label={label}
        button={button}
        busyLabel="Sending..."
        helper={helper}
        success={success}
        onSubmit={async (email) => {
          arm();
          for (let k = 0; k < 30 && !token.current && !failed.current; k++) await new Promise((r) => setTimeout(r, 150));
          try {
            const res = await fetch(`/api/grade/${jobId}/email`, {
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
                  : b.error === "unavailable" || b.error === "email_unavailable"
                    ? "Email isn't available right now. Keep this page's link and come back later."
                    : b.error === "rate_limited" || b.error === "too_many"
                      ? "That's enough emails for this report for now."
                      : "That didn't work. Try again in a moment.",
            };
          } catch {
            return { ok: false, error: "We couldn't reach PortfolioRank. Check your connection and try again." };
          }
        }}
      />
      {armed && (
        <Turnstile
          ref={widget}
          action="grade-email"
          onToken={(t) => (token.current = t)}
          onExpire={() => (token.current = null)}
          onError={() => (failed.current = true)}
          className="empty:hidden"
        />
      )}
    </div>
  );
}
