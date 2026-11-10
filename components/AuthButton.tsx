"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { useSignIn } from "@/components/SignInModal";

type SessionInfo = { login?: string; user?: { image?: string | null } } | null;

// Client-side session widget so server pages that render the Header can stay
// static (auth() in the Header would force every page dynamic).
export function AuthButton() {
  const [session, setSession] = useState<SessionInfo>(null);
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const openSignIn = useSignIn();
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // The account menu is a disclosure: a click anywhere outside or Escape closes
  // it (Escape hands focus back to its button). No full-screen click catcher,
  // which an ancestor's backdrop-filter would shrink to the header.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        setSession(s && Object.keys(s).length > 0 ? s : null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // Reserve space while the session loads so the nav doesn't jump (pop-in).
  if (!loaded)
    return (
      <span
        aria-hidden
        className="h-7 w-20 animate-pulse rounded-lg bg-edge"
      />
    );

  if (session?.login) {
    return (
      <div ref={menuRef} className="relative">
        <button
          ref={toggleRef}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-ink transition hover:border-accent"
          aria-expanded={menuOpen}
          aria-controls="account-menu"
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
          <span className="sr-only">, account menu</span>
          <span aria-hidden className={`transition ${menuOpen ? "rotate-180" : ""}`}>⌄</span>
        </button>
        {menuOpen && (
          <>
            <div
              id="account-menu"
              className="absolute right-0 z-30 mt-1 w-40 overflow-hidden rounded-lg border border-edge bg-card text-sm shadow-lg"
            >
              <a
                href="/profile"
                className="block px-3 py-2 transition hover:bg-edge"
              >
                My profile
              </a>
              <a
                href="/votes"
                className="block px-3 py-2 transition hover:bg-edge"
              >
                My votes
              </a>
              <a
                href="/settings"
                className="block px-3 py-2 transition hover:bg-edge"
              >
                Settings
              </a>
              <button
                onClick={() => signOut({ callbackUrl: "/" })}
                className="block w-full px-3 py-2 text-left text-mute transition hover:bg-edge hover:text-ink"
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => openSignIn()}
        className="rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold text-mute transition hover:border-mute hover:text-ink sm:text-sm"
      >
        Sign in
      </button>
    </>
  );
}
