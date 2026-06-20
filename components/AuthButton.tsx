"use client";

import { useEffect, useState } from "react";
import { SignInModal } from "@/components/SignInModal";

type SessionInfo = { login?: string; user?: { image?: string | null } } | null;

// Client-side session widget so server pages that render the Header can stay
// static (auth() in the Header would force every page dynamic).
export function AuthButton() {
  const [session, setSession] = useState<SessionInfo>(null);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        setSession(s && Object.keys(s).length > 0 ? s : null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  if (session?.login) {
    return (
      <span className="flex items-center gap-1">
        <a
          href="/votes"
          className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-ink transition hover:border-accent"
          title="My votes & history"
        >
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="h-5 w-5 rounded-full"
            />
          )}
          <span className="max-w-[7rem] truncate">{session.login}</span>
        </a>
        <a
          href="/api/auth/signout"
          className="rounded-lg px-2 py-1 text-xs font-medium text-mute transition hover:text-ink"
          title="Sign out"
        >
          Sign out
        </a>
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => setModal(true)}
        className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-mute transition hover:border-mute hover:text-ink sm:text-sm"
      >
        Sign in
      </button>
      <SignInModal open={modal} onClose={() => setModal(false)} />
    </>
  );
}
