"use client";

import { useCallback, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** False during server rendering and hydration, true after: for browser-only UI such as portals. */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
}

const FLAG_EVENT = "portfoliorank:stored-flag";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * An on/off preference kept in localStorage ("1"/"0"), shared live by every
 * component on the page and other tabs. Off while rendering on the server.
 */
export function useStoredFlag(key: string): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => e.key === key && onChange();
      window.addEventListener("storage", onStorage);
      window.addEventListener(FLAG_EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(FLAG_EVENT, onChange);
      };
    },
    [key]
  );
  const value = useSyncExternalStore(
    subscribe,
    () => readFlag(key),
    () => false
  );
  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* private mode: the toggle just doesn't persist */
      }
      window.dispatchEvent(new Event(FLAG_EVENT));
    },
    [key]
  );
  return [value, set];
}
