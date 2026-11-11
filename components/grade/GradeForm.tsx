"use client";

import { useId, useRef, useState } from "react";
import { KeyRound, Link2, Loader2, Sparkles } from "lucide-react";
import { FreeTierNote } from "@/components/grade/FreeTierNote";
import { goToMine, useGradeRequest } from "@/components/grade/useGradeRequest";

const LOOKS_LIKE_URL = /^(https?:\/\/)?[^\s./]+\.[^\s]{2,}$/;

/**
 * Paste a link, grade it (GRADER_ENABLED; pages render it only when it's on).
 * On success the visitor lands on their portfolio page, which follows the
 * grade. Optionally with the visitor's own Gemini key, used once and kept in
 * this tab only.
 */
export function GradeForm({ compact = false, center = false }: { compact?: boolean; center?: boolean }) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [error, setError] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const { arm, submit, busy, turnstile } = useGradeRequest();

  return (
    <form
      noValidate
      onFocus={arm}
      onPointerEnter={arm}
      onSubmit={async (e) => {
        e.preventDefault();
        const v = url.trim();
        if (!LOOKS_LIKE_URL.test(v)) {
          setError("Paste your portfolio's address, like yourname.dev.");
          return;
        }
        setError("");
        const r = await submit(v, ownKey ? key.trim() : null);
        if (r.ok || r.report) return goToMine();
        setError(r.message);
      }}
      className="w-full"
      aria-busy={busy}
    >
      <label htmlFor={`${id}-url`} className="sr-only">
        Your portfolio address
      </label>
      <div className={`flex gap-2 ${compact ? "" : "flex-col sm:flex-row"}`}>
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
          <input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="yourname.dev"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            className={`w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none transition placeholder:text-mute/80 focus:border-accent ${compact ? "h-11" : "h-12"}`}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition active:scale-[0.97] disabled:opacity-70 ${
            compact ? "h-11 border border-edge bg-card px-4 text-sm hover:border-edge-strong" : "group btn-sheen h-12 bg-fill px-6 text-[15px] text-on-fill"
          }`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : !compact && <Sparkles className="icon-twinkle h-4 w-4" aria-hidden />}
          {busy ? "Starting" : compact ? "Grade" : "Grade it"}
        </button>
      </div>
      {ownKey && (
        <div className="mt-2">
          <label htmlFor={`${id}-key`} className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <KeyRound className="h-3.5 w-3.5 text-mute" aria-hidden /> Your Gemini API key
          </label>
          <input
            ref={keyInput}
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="AIza..."
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError("");
            }}
            aria-describedby={`${id}-key-help`}
            className="h-11 w-full rounded-lg border border-edge bg-card px-3 text-sm outline-none transition placeholder:text-mute/80 focus:border-accent"
          />
          <p id={`${id}-key-help`} className="mt-1 text-xs text-mute">
            Used once for this grade, on your quota. Never stored or logged.
          </p>
        </div>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
      {turnstile}
      <FreeTierNote
        className="mt-2.5"
        center={center}
        onUseKey={
          ownKey
            ? undefined
            : () => {
                setOwnKey(true);
                requestAnimationFrame(() => keyInput.current?.focus());
              }
        }
      />
    </form>
  );
}
