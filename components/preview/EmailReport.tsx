"use client";

import { useState } from "react";
import { ArrowRight, MailCheck, Mail } from "lucide-react";

/**
 * No account needed: leave an email and get a one-time link to the report.
 * Mocked: the "sent" state shows the email the visitor would receive.
 */
export function EmailReport({ domain, reportHref, initialSent = null }: { domain: string; reportHref: string; initialSent?: string | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(initialSent);
  const [error, setError] = useState("");

  if (sent)
    return (
      <section aria-labelledby="mail-sent" className="card p-5 sm:p-6">
        <p id="mail-sent" role="status" className="flex items-center gap-2 font-semibold">
          <MailCheck className="h-5 w-5 text-up" aria-hidden /> Sent to {sent}
        </p>
        <p className="mt-1 text-sm text-mute">The link works once and expires in 7 days. No account, no password.</p>
        {/* Preview of the email (mocked, nothing is sent). */}
        <figure className="mt-4 overflow-hidden rounded-xl border border-edge bg-bg/40">
          <figcaption className="flex items-center justify-between gap-2 border-b border-edge px-4 py-2 text-xs text-mute">
            <span>Preview of the email</span>
            <span className="rounded-full border border-dashed border-edge-strong px-1.5 text-[10px] font-semibold uppercase tracking-wide">Mock</span>
          </figcaption>
          <div className="px-4 py-4 text-sm">
            <p className="text-xs text-mute">From PortfolioRank &lt;reports@portfoliorank.n8builds.dev&gt;</p>
            <p className="mt-0.5 font-semibold">Your PortfolioRank report for {domain} is ready</p>
            <div className="mt-3 rounded-lg border border-edge bg-card p-4">
              <p>Hi,</p>
              <p className="mt-2">Your grade for {domain} is ready: the tier, where you&apos;d rank, and the three things to fix first.</p>
              <a href={reportHref} className="group btn-sheen mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-fill px-4 font-semibold text-on-fill">
                Open my report <ArrowRight className="nudge h-4 w-4" aria-hidden />
              </a>
              <p className="mt-3 text-xs text-mute">This link works once and expires in 7 days. Didn&apos;t ask for this? Ignore it; nothing else happens.</p>
            </div>
          </div>
        </figure>
      </section>
    );

  return (
    <section aria-labelledby="mail-me" className="card p-5 sm:p-6">
      <h2 id="mail-me" className="flex items-center gap-2 font-semibold">
        <Mail className="h-4 w-4 text-mute" aria-hidden /> Get it by email, no account needed
      </h2>
      <p className="mt-1 text-sm text-mute">We send a one-time link to your report. You can close this page.</p>
      <form
        className="mt-3 flex gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            setError("Enter an email like you@example.com.");
            return;
          }
          setSent(email.trim());
        }}
      >
        <label htmlFor="report-email" className="sr-only">
          Email
        </label>
        <input
          id="report-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError("");
          }}
          aria-invalid={!!error}
          aria-describedby={error ? "report-email-error" : undefined}
          className="h-11 min-w-0 flex-1 rounded-lg border border-edge bg-card px-3 text-sm outline-none focus:border-accent"
        />
        <button type="submit" className="h-11 shrink-0 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] hover:border-edge-strong">
          Email me the link
        </button>
      </form>
      {error && (
        <p id="report-email-error" className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
    </section>
  );
}
