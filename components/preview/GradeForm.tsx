"use client";

import { useState } from "react";
import { Link2, Sparkles } from "lucide-react";
import { FreeTierNote } from "@/components/preview/FreeTierNote";

/** Paste a link, grade it. The preview goes to the mocked progress page. */
export function GradeForm({ compact = false, id = "grade-url" }: { compact?: boolean; id?: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const v = url.trim();
        if (!/^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/.test(v)) {
          setError("Paste your portfolio's address, like yourname.dev.");
          return;
        }
        location.href = `/grade?url=${encodeURIComponent(v)}`;
      }}
      className="w-full"
    >
      <label htmlFor={id} className="sr-only">
        Your portfolio address
      </label>
      <div className={`flex gap-2 ${compact ? "" : "flex-col sm:flex-row"}`}>
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
          <input
            id={id}
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="yourname.dev"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className={`w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none transition placeholder:text-mute/80 focus:border-accent ${compact ? "h-10" : "h-12"}`}
          />
        </div>
        <button
          type="submit"
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition active:scale-[0.97] ${
            compact ? "h-10 border border-edge px-4 text-sm hover:border-mute" : "group btn-sheen h-12 bg-fill px-6 text-[15px] text-on-fill"
          }`}
        >
          {!compact && <Sparkles className="icon-twinkle h-4 w-4" aria-hidden />}
          {compact ? "Grade" : "Grade it"}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
      <FreeTierNote className="mt-2.5" center={!compact} />
    </form>
  );
}
