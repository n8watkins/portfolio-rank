"use client";

import { useEffect, useState } from "react";

type SessionInfo = { login?: string; user?: { image?: string | null } } | null;

// Client-side session widget so server pages that render the Header can stay
// static (auth() in the Header would force every page dynamic).
export function AuthButton() {
  const [session, setSession] = useState<SessionInfo>(null);
  const [loaded, setLoaded] = useState(false);

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
      <span className="flex items-center gap-1.5">
        <a
          href="/votes"
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2 py-1 text-xs font-semibold transition hover:border-mute"
          title="My votes"
        >
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="h-5 w-5 rounded-full"
            />
          )}
          {session.login}
        </a>
        <a
          href="/api/auth/signout"
          className="px-1.5 py-1 text-xs text-mute transition hover:text-ink"
          title="Sign out"
        >
          ✕
        </a>
      </span>
    );
  }

  return (
    <a
      href="/api/auth/signin?callbackUrl=/rank"
      className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-mute transition hover:border-mute hover:text-ink sm:text-sm"
    >
      Sign in
    </a>
  );
}
