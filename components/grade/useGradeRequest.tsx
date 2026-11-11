"use client";

import { useCallback, useRef, useState } from "react";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";

/** Where a visitor's own Gemini key waits for its one use (this tab only, never sent to us but for that grade). */
export const ownKeySlot = (id: string) => `pr-gemini-key:${id}`;

export type GradeOutcome =
  | { ok: true; id: string }
  | { ok: false; error: string; message: string; nextAt?: string | null; report?: string };

const FALLBACK: Record<string, string> = {
  bad_request: "Paste your portfolio's address, like yourname.dev.",
  bad_origin: "Something went wrong. Reload the page and try again.",
  turnstile_failed: "We couldn't check that you're a person. Try again.",
  rate_limited: "That's a lot of grades in a short time. Try again in a little while.",
  own_key_invalid: "That doesn't look like a Gemini API key.",
  own_key_rejected: "Gemini didn't accept that key. Check it and try again.",
  not_found: "Grading isn't open right now.",
  network: "We couldn't reach PortfolioRank. Check your connection and try again.",
};

/**
 * Starts a grade (POST /api/grade): the Turnstile check, the request and its
 * answers in plain words. On success the visitor goes to the report's page,
 * which shows the progress. The widget is invisible unless Cloudflare
 * wants an interaction; it loads when the form is first used, never on page
 * load.
 */
export function useGradeRequest() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);
  const failed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);

  const arm = useCallback(() => {
    if (armed) return;
    prefetchTurnstile();
    setArmed(true);
  }, [armed]);

  /** Waits up to a few seconds for the Turnstile token; the server decides without one. */
  const waitForToken = async () => {
    for (let k = 0; k < 30 && !token.current && !failed.current; k++) await new Promise((r) => setTimeout(r, 150));
    return token.current;
  };

  const submit = useCallback(
    async (url: string, geminiKey?: string | null): Promise<GradeOutcome> => {
      arm();
      setBusy(true);
      try {
        const turnstileToken = await waitForToken();
        let res: Response;
        try {
          res = await fetch("/api/grade", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, ...(turnstileToken ? { turnstileToken } : {}), ...(geminiKey ? { geminiKey } : {}) }),
          });
        } catch {
          return { ok: false, error: "network", message: FALLBACK.network };
        }
        // A token is good for one request.
        token.current = null;
        widget.current?.reset();
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 202 && typeof body.id === "string") {
          if (geminiKey) {
            try {
              sessionStorage.setItem(ownKeySlot(body.id), geminiKey);
            } catch {}
          }
          return { ok: true, id: body.id };
        }
        const error = typeof body.error === "string" ? body.error : "unknown";
        const message = typeof body.message === "string" && body.message ? body.message : (FALLBACK[error] ?? "Something went wrong. Try again in a moment.");
        return {
          ok: false,
          error,
          message,
          nextAt: typeof body.nextAt === "string" ? body.nextAt : null,
          ...(typeof body.report === "string" ? { report: body.report } : {}),
        };
      } finally {
        setBusy(false);
      }
    },
    [arm]
  );

  const turnstile = armed ? (
    <Turnstile
      ref={widget}
      action="grade"
      onToken={(t) => (token.current = t)}
      onExpire={() => (token.current = null)}
      onError={() => (failed.current = true)}
      className="empty:hidden"
    />
  ) : null;

  return { arm, submit, busy, turnstile };
}

/** After a grade starts (or one is already running or recent for this address): its progress and report page. */
export const reportHref = (id: string) => `/grade/${encodeURIComponent(id)}`;
