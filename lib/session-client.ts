"use client";

import { useSyncExternalStore } from "react";

// The signed-in user, read once per page load from Auth.js and shared by
// every shell component (header account menu, phone More sheet). Read on the
// client so pages that render the shell can stay static: auth() on the
// server would make every page dynamic.

export type ClientSession = {
  /** The GitHub login, or the address for an email account. */
  login: string;
  /** How the account signs in (auth.ts). */
  provider: "github" | "email";
  name: string | null;
  email: string | null;
  image: string | null;
};

/** "loading" until the session answers, then the user or null. */
export type SessionState = ClientSession | null | "loading";

let state: SessionState = "loading";
let started = false;
const listeners = new Set<() => void>();

function load() {
  if (started) return;
  started = true;
  fetch("/api/auth/session")
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { login?: string; provider?: string; user?: { name?: string | null; email?: string | null; image?: string | null } } | null) => {
      state = s?.login
        ? {
            login: s.login,
            provider: s.provider === "email" ? "email" : "github",
            name: s.user?.name ?? null,
            email: s.user?.email ?? null,
            image: s.user?.image ?? null,
          }
        : null;
    })
    .catch(() => {
      state = null;
    })
    .finally(() => listeners.forEach((l) => l()));
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  load();
  return () => listeners.delete(onChange);
}

export function useClientSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => "loading" as const
  );
}
