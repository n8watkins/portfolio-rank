"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { Modal } from "@/components/Modal";
import { EmailSignIn } from "@/components/signin/EmailSignIn";

// One sign-in dialog for the whole site, mounted in the root layout. Anything
// that needs a signed-in user calls useSignIn()(...) with its own wording.
// Two ways in (auth.ts): GitHub, whose button starts OAuth directly (one
// redirect to GitHub and back to the page you were on), and an emailed
// one-time link (components/signin/EmailSignIn) that comes back to the same
// page.
//
// It also opens from the address bar: /?signin (with an optional callbackUrl
// and error) is Auth.js's sign-in and error page (auth.ts pages), so its stock
// page never shows.

export type SignInPrompt = {
  title?: string;
  body?: string;
  /** Label for the dismiss link; null hides it (Escape, the close button and the backdrop still close). */
  skipLabel?: string | null;
};

type State = SignInPrompt & { callbackUrl?: string; error?: string };

const DEFAULTS = {
  title: "Make your votes count",
  body: "Sign in so your picks move the official rankings - one account, one vote per matchup.",
  skipLabel: "Not now",
};

const SignInContext = createContext<((prompt?: SignInPrompt) => void) | null>(null);

/** Opens the sign-in dialog. */
export function useSignIn() {
  const open = useContext(SignInContext);
  if (!open) throw new Error("useSignIn must be used inside SignInProvider");
  return open;
}

/** Only same-site paths are followed after sign-in. */
function safeCallback(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : undefined;
  } catch {
    return undefined;
  }
}

/** The dialog state /?signin asks for, or null. */
function fromAddress(): State | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("signin")) return null;
  const error = url.searchParams.get("error") ?? undefined;
  return {
    callbackUrl: safeCallback(url.searchParams.get("callbackUrl")),
    error,
    title: error ? "Sign-in didn't finish" : "Sign in to PortfolioRank",
    body: error
      ? "The sign-in didn't complete. Try again, or use the other way in below."
      : "Vote in the official rankings, like portfolios and keep lists. One account, one vote per matchup.",
  };
}

export function SignInProvider({ children }: { children: React.ReactNode }) {
  // The ?signin deep link opens it on arrival. The dialog itself renders only
  // after hydration (Modal), so reading the address here can't cause a mismatch.
  const [state, setState] = useState<State | null>(fromAddress);

  const open = useCallback((prompt?: SignInPrompt) => setState({ ...prompt }), []);
  const close = useCallback(() => setState(null), []);

  // Tidy the address so a reload doesn't reopen it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("signin")) return;
    for (const k of ["signin", "callbackUrl", "error"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);

  const value = useMemo(() => open, [open]);
  const s = {
    ...state,
    title: state?.title ?? DEFAULTS.title,
    body: state?.body ?? DEFAULTS.body,
    skipLabel: state?.skipLabel === undefined ? DEFAULTS.skipLabel : state.skipLabel,
  };

  return (
    <SignInContext.Provider value={value}>
      {children}
      <Modal open={state !== null} onClose={close} title={s.title} description={s.body} className="text-center">
        <button
          type="button"
          onClick={() =>
            signIn("github", {
              redirectTo: s.callbackUrl ?? window.location.pathname + window.location.search,
            })
          }
          className="mt-5 flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg bg-fill px-4 py-2.5 text-sm font-semibold text-on-fill transition hover:opacity-85"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          Continue with GitHub
        </button>

        <div className="my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-mute" aria-hidden>
          <span className="h-px flex-1 bg-edge" /> or <span className="h-px flex-1 bg-edge" />
        </div>

        <EmailSignIn callbackUrl={s.callbackUrl ?? (typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)} />

        <p className="mt-4 text-xs text-mute">
          GitHub shares only your public profile; email, only your address. Either way, one account counts one vote.
        </p>

        {s.skipLabel && (
          <button
            type="button"
            onClick={close}
            className="mt-2 min-h-11 px-2 text-xs font-medium text-mute underline underline-offset-2 transition hover:text-ink"
          >
            {s.skipLabel}
          </button>
        )}
      </Modal>
    </SignInContext.Provider>
  );
}

/** A plain "Sign in" button for server pages (profile, votes) that opens the dialog. */
export function SignInButton({ className = "", children = "Sign in", ...prompt }: SignInPrompt & { className?: string; children?: React.ReactNode }) {
  const signInPrompt = useSignIn();
  return (
    <button type="button" onClick={() => signInPrompt(prompt)} className={className}>
      {children}
    </button>
  );
}
