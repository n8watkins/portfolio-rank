"use client";

import { useState } from "react";
import { CircleCheck, Mail, TrendingUp, FileText, Sparkles } from "lucide-react";

/** The designed newsletter box: home band and the blog sidebar. */
export function NewsletterFeature({ layout = "wide", id = "nlf" }: { layout?: "wide" | "side"; id?: string }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const wide = layout === "wide";
  return (
    <section
      aria-labelledby={`${id}-t`}
      className={`card card-featured relative overflow-hidden ${wide ? "grid grid-cols-1 items-center gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : "p-5 sm:p-6"}`}
    >
      <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(closest-side,rgba(251,191,36,0.16),transparent)]" aria-hidden />
      <div className="relative">
        <span className="icon-tile h-10 w-10">
          <Mail className="h-5 w-5" aria-hidden />
        </span>
        <h2 id={`${id}-t`} className={`mt-3 font-bold tracking-tight ${wide ? "text-2xl" : "text-lg"}`}>
          The weekly ranking, in your inbox
        </h2>
        <ul className="mt-3 grid gap-1.5 text-sm text-mute">
          <li className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 shrink-0" aria-hidden /> The week&apos;s climbers and fallers
          </li>
          <li className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0" aria-hidden /> New reports from the data
          </li>
          <li className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" aria-hidden /> One portfolio worth stealing from
          </li>
        </ul>
      </div>
      <div className="relative">
        {done ? (
          <p role="status" className="pop-in flex items-center gap-2 rounded-xl border border-up/40 bg-up/10 p-4 text-sm font-medium">
            <CircleCheck className="h-5 w-5 text-up" aria-hidden /> Check your inbox to confirm. One email a week, unsubscribe any time.
          </p>
        ) : (
          <form
            className={wide ? "" : "mt-4"}
            onSubmit={(e) => {
              e.preventDefault();
              if (email.includes("@")) setDone(true);
            }}
          >
            <label htmlFor={`${id}-email`} className="text-sm font-medium">
              Your email
            </label>
            <div className={`mt-1.5 flex gap-2 rounded-xl border border-edge bg-bg/60 p-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] focus-within:border-accent/60 ${wide ? "" : "flex-col"}`}>
              <input
                id={`${id}-email`}
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 min-w-0 flex-1 rounded-lg bg-transparent px-3 text-[15px] outline-none placeholder:text-mute/80"
              />
              <button type="submit" className="btn-sheen h-11 shrink-0 rounded-lg px-5 text-sm font-semibold">
                Subscribe
              </button>
            </div>
            <p className="mt-2 text-xs text-mute">One email a week. No spam, unsubscribe in one click.</p>
          </form>
        )}
      </div>
    </section>
  );
}
