"use client";

import { useCallback, useRef, useState } from "react";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";

export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

const FALLBACK: Record<string, string> = {
  bad_request: "Paste your portfolio's address, like yourname.dev.",
  bad_origin: "Something went wrong. Reload the page and try again.",
  turnstile_failed: "We couldn't check that you're a person. Reload the page and try again.",
  rate_limited: "That's a lot of checks in a short time. Try again in a little while.",
  daily_limit: "That's today's limit of free checks. It resets at midnight Pacific time.",
  not_found: "The free tools aren't open right now.",
  network: "We couldn't reach PortfolioRank. Check your connection and try again.",
};

/**
 * Posts a free-tool request (app/api/tools/*) with a Turnstile token under
 * the action "tools". Like the grade form: the widget loads when the form
 * is first used, is invisible unless Cloudflare wants an interaction, and a
 * token is good for one request.
 */
export function useToolRequest() {
  const [armed, setArmed] = useState(false);
  const token = useRef<string | null>(null);
  const failed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);

  const arm = useCallback(() => {
    if (armed) return;
    prefetchTurnstile();
    setArmed(true);
  }, [armed]);

  // Set when Cloudflare shows its checkbox: the token waits for the visitor's tick.
  const interactive = useRef(false);
  const [needsTick, setNeedsTick] = useState(false);

  /** Waits a few seconds for the token, or up to two minutes while the checkbox waits for a tick. */
  const waitForToken = async () => {
    const start = Date.now();
    while (!token.current && !failed.current && Date.now() - start < (interactive.current ? 120_000 : 6_000)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    setNeedsTick(false);
    return token.current;
  };

  const post = useCallback(
    async <T,>(path: string, body: Record<string, unknown>): Promise<ToolOutcome<T>> => {
      arm();
      const turnstileToken = await waitForToken();
      let res: Response;
      try {
        res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, ...(turnstileToken ? { turnstileToken } : {}) }),
        });
      } catch {
        return { ok: false, error: "network", message: FALLBACK.network };
      }
      token.current = null;
      widget.current?.reset();
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { ok: true, data: data as T };
      const error = typeof data.error === "string" ? data.error : "unknown";
      const message = typeof data.message === "string" && data.message ? data.message : (FALLBACK[error] ?? "Something went wrong. Try again in a moment.");
      return { ok: false, error, message };
    },
    [arm]
  );

  const turnstile = armed ? (
    <Turnstile
      ref={widget}
      action="tools"
      onToken={(t) => {
        token.current = t;
        setNeedsTick(false);
      }}
      onExpire={() => (token.current = null)}
      onError={() => (failed.current = true)}
      onInteractive={() => {
        interactive.current = true;
        setNeedsTick(true);
      }}
      className="empty:hidden mt-3"
    />
  ) : null;

  return { arm, post, turnstile, needsTick };
}
