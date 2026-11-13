"use client";

import { useSyncExternalStore } from "react";

// The signed-in user, read once per page load from Auth.js and shared by
// every shell component (header account menu, phone More sheet). Read on the
// client so pages that render the shell can stay static: auth() on the
// server would make every page dynamic.

export type ClientSession = {
  login: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/** "loading" until the session answers, then the user or null. */
export type SessionState = ClientSession | null | "loading";

let state: SessionState = "loading";
let started = false;
const listeners = new Set<() => void>();

// The one /api/auth/session request of a page load, shared by the shell and
// anything else that needs the raw answer (components/ClaimVotes.tsx). Client
// navigation keeps it, so moving between pages asks nothing.
export type RawSession = {
  login?: string;
  raterId?: string;
  provider?: string;
  isAdmin?: boolean;
  user?: { name?: string | null; email?: string | null; image?: string | null };
};
let raw: Promise<RawSession | null> | null = null;
export function readSession(): Promise<RawSession | null> {
  raw ??= fetch("/api/auth/session").then((r) => (r.ok ? r.json() : null));
  return raw;
}

function load() {
  if (started) return;
  started = true;
  readSession()
    .then((s: { login?: string; user?: { name?: string | null; email?: string | null; image?: string | null } } | null) => {
      state = s?.login
        ? { login: s.login, name: s.user?.name ?? null, email: s.user?.email ?? null, image: s.user?.image ?? null }
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
