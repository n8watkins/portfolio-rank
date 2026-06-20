"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  body?: string;
  /** Label for the dismiss link; null hides it (modal still closes via backdrop/Esc). */
  skipLabel?: string | null;
};

// In-app sign-in: provider buttons that kick off OAuth directly (one redirect
// to the provider and back to the current page), instead of routing through
// the default Auth.js sign-in page. Google's button appears automatically
// once its credentials are configured (read from /api/auth/providers).
export function SignInModal({
  open,
  onClose,
  title = "Make your votes count",
  body = "Sign in so your picks move the official rankings — one account, one vote per matchup.",
  skipLabel = "Not now",
}: Props) {
  const [hasGoogle, setHasGoogle] = useState(false);

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => setHasGoogle(Boolean(p?.google)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const go = (provider: "github" | "google") =>
    signIn(provider, { redirectTo: window.location.pathname });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        // Stop the click from bubbling — the modal can be a DOM descendant of a
        // navigating <a> (e.g. a browse-grid card), where a bare backdrop click
        // would otherwise trigger that link instead of just closing.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-edge bg-card p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg font-bold tracking-tight">{title}</p>
        <p className="mt-2 text-sm text-mute">{body}</p>

        <div className="mt-5 space-y-2.5">
          <button
            onClick={() => go("github")}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            Continue with GitHub
          </button>

          {hasGoogle && (
            <button
              onClick={() => go("google")}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-edge px-4 py-2.5 text-sm font-semibold transition hover:border-mute"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                <path
                  fill="#4285F4"
                  d="M23.49 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.86c2.26-2.09 3.57-5.17 3.57-8.81Z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.86-3c-1.07.72-2.44 1.15-4.08 1.15-3.13 0-5.79-2.11-6.74-4.96H1.27v3.09A12 12 0 0 0 12 24Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.26 14.28A7.2 7.2 0 0 1 4.88 12c0-.79.14-1.56.38-2.28V6.63H1.27a12 12 0 0 0 0 10.74l3.99-3.09Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.76c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.63l3.99 3.09C6.21 6.87 8.87 4.76 12 4.76Z"
                />
              </svg>
              Continue with Google
            </button>
          )}
        </div>

        <p className="mt-4 text-xs text-mute">
          We only see your public profile — used to count one vote per person.
        </p>

        {skipLabel && (
          <button
            onClick={onClose}
            className="mt-3 text-xs font-medium text-mute underline underline-offset-2 transition hover:text-ink"
          >
            {skipLabel}
          </button>
        )}
      </div>
    </div>
  );
}
