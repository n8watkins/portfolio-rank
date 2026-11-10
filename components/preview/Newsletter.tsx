"use client";

import { useState } from "react";
import { CircleCheck, Mail } from "lucide-react";

/** Newsletter sign-up (mocked: nothing is sent). */
export function Newsletter({ className = "" }: { className?: string }) {
  const [done, setDone] = useState(false);
  const [email, setEmail] = useState("");
  return (
    <section aria-labelledby="nl-title" className={`card flex flex-col p-5 ${className}`}>
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-mute" aria-hidden />
        <h2 id="nl-title" className="text-base font-bold tracking-tight">
          The weekly ranking, in your inbox
        </h2>
      </div>
      <p className="mt-1.5 text-sm text-mute">Climbers, new reports and one portfolio worth stealing from. One email a week.</p>
      {done ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm font-medium text-up">
          <CircleCheck className="h-4 w-4" aria-hidden /> Check your inbox to confirm.
        </p>
      ) : (
        <form
          className="mt-auto flex gap-2 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.includes("@")) setDone(true);
          }}
        >
          <label htmlFor="nl-email" className="sr-only">
            Email
          </label>
          <input
            id="nl-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-edge bg-bg px-3 text-sm outline-none placeholder:text-mute/80 focus:border-accent"
          />
          <button type="submit" className="btn-sheen h-10 shrink-0 rounded-lg bg-fill px-4 text-sm font-semibold text-on-fill transition">
            Subscribe
          </button>
        </form>
      )}
    </section>
  );
}
