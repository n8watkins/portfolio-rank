"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { TURNSTILE_SITE_KEY } from "@/lib/site";

// Cloudflare Turnstile, managed mode with appearance "interaction-only": most
// visitors never see it, and it shows a checkbox only when Cloudflare wants
// one. Its script loads on intent (prefetchTurnstile on hover or focus of
// the form, or when the widget mounts), never on page load. The server
// checks the token with verifyTurnstile (lib/turnstile.ts) under the same
// action name.
//
// Usage:
//   const ts = useRef<TurnstileHandle>(null);
//   <form onFocus={prefetchTurnstile} onPointerEnter={prefetchTurnstile}>
//     <Turnstile ref={ts} action="grade" onToken={setToken} />
//   ...after a submit, ts.current?.reset() for a fresh token.
// When the widget can't load (blocked, offline, an unlisted host in local
// runs), onError fires; send the request anyway, and the server decides
// (it skips the check when no secret is set, and refuses otherwise).

type Widget = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: Widget;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<Widget> | null = null;

function load(): Promise<Widget> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<Widget>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start")));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error("Turnstile could not load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Starts loading the script early (call on hover or focus of a form that needs it). */
export function prefetchTurnstile() {
  load().catch(() => {});
}

export type TurnstileHandle = { reset: () => void };

export const Turnstile = forwardRef<
  TurnstileHandle,
  {
    /** The action the server expects ("grade", "grade-email", "poll-vote"). */
    action: string;
    onToken: (token: string) => void;
    /** The token expired or the widget failed: clear any stored token. */
    onExpire?: () => void;
    onError?: () => void;
    /** Cloudflare wants the visitor to tick the box: the token comes only after they do. */
    onInteractive?: () => void;
    className?: string;
  }
>(function Turnstile({ action, onToken, onExpire, onError, onInteractive, className = "" }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  // The latest callbacks, without re-rendering the widget when they change.
  const cb = useRef({ onToken, onExpire, onError, onInteractive });
  useEffect(() => {
    cb.current = { onToken, onExpire, onError, onInteractive };
  });

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (id.current && window.turnstile) window.turnstile.reset(id.current);
    },
  }));

  useEffect(() => {
    let alive = true;
    load()
      .then((t) => {
        if (!alive || !box.current) return;
        const dark =
          document.documentElement.dataset.theme === "dark" ||
          (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
        id.current = t.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          appearance: "interaction-only",
          theme: dark ? "dark" : "light",
          callback: (token: string) => cb.current.onToken(token),
          "expired-callback": () => cb.current.onExpire?.(),
          "before-interactive-callback": () => cb.current.onInteractive?.(),
          "error-callback": () => {
            cb.current.onExpire?.();
            cb.current.onError?.();
          },
        });
      })
      .catch(() => alive && cb.current.onError?.());
    return () => {
      alive = false;
      if (id.current && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [action]);

  return <div ref={box} className={className} />;
});
