"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ownKeySlot } from "@/components/grade/useGradeRequest";
import { ACTIVE_STATES } from "@/lib/grader/jobs.mjs";
import type { Job } from "@/lib/me";

const ACTIVE_STATUSES = new Set<string>(ACTIVE_STATES);
const EVERY = 4000;

/**
 * A grade on its way, kept live: GET /api/grade/<id> every few seconds while
 * it runs, then a refresh of the page so the server renders the report (or
 * the failure). An own-key grade sends the key the visitor typed on the form
 * (kept in this tab only) once, as soon as the capture is ready; `finish`
 * sends a typed key or hands the grade to the free tier.
 */
export function useGradeJob<T extends Job>(initial: T) {
  const router = useRouter();
  const [job, setJob] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState("");

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(job.status)) {
      if (job.status !== initial.status) router.refresh();
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/grade/${job.id}`, { cache: "no-store" });
        if (res.ok) setJob(await res.json());
        else if (res.status === 404) router.refresh();
      } catch {}
    }, EVERY);
    return () => clearTimeout(t);
  }, [job, initial.status, router]);

  const finish = useCallback(
    async (body: { geminiKey: string } | { freeTier: true }) => {
      setBusy(true);
      setKeyError("");
      try {
        const res = await fetch(`/api/grade/${job.id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const b = await res.json().catch(() => ({}));
        if (res.ok) {
          try {
            sessionStorage.removeItem(ownKeySlot(job.id));
          } catch {}
          setJob(b as T);
        } else setKeyError(typeof b.message === "string" ? b.message : "Gemini didn't accept that key. Check it, or use the free tier.");
      } catch {
        setKeyError("We couldn't reach PortfolioRank. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [job.id]
  );

  // The key the visitor gave on the grade form, kept in this tab for its one use.
  const sent = useRef(false);
  useEffect(() => {
    if (job.status !== "awaiting_key" || sent.current) return;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(ownKeySlot(job.id));
    } catch {}
    if (stored) {
      sent.current = true;
      void finish({ geminiKey: stored });
    }
  }, [job.status, job.id, finish]);

  return { job, setJob, finish, busy, keyError };
}

/** What the visitor is waiting for, in one line. */
export function waitingLine(job: Pick<Job, "status" | "reason">): string {
  switch (job.status) {
    case "waiting":
      return job.reason ?? "Today's grading is full, so yours starts tomorrow.";
    case "queued":
      return "Today's AI grading is used up, so yours is first in line tomorrow morning.";
    case "grading":
      return "Gemini is looking at your page now. This takes about a minute.";
    case "awaiting_key":
      return "The screenshot is ready. Your Gemini key finishes the grade.";
    default:
      return "Usually under a minute. You can leave; the report keeps its link.";
  }
}

/** Each step's state, for screen readers. */
export const STATE_WORD: Record<string, string> = {
  done: "done",
  running: "in progress",
  waiting: "waiting",
  pending: "not started",
  needs_key: "needs your key",
  failed: "failed",
  off: "not available",
};
