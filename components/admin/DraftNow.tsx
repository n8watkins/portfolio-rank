"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, PenLine, Server } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

// "Write a draft now" (POST /api/admin/content/draft): an optional topic or
// angle and story. The draft is written on the server by a Workflow
// (worker/draft.ts), so it keeps going when the page is refreshed or
// closed. While it runs, DraftInProgress is the first row of "Waiting for
// you": the step it is on and the time so far, polled every few seconds
// from GET /api/admin/content/draft?id=, and rendered by the server on a
// refresh, so it survives one. When it ends the page refreshes and the
// draft is in the list.

export type Calls = { attempts: number; answered: number; busy: number; backup: number };
export type Job = {
  id: string;
  kind: string | null;
  topic: string | null;
  rewriteOf: string | null;
  status: string;
  phase: string | null;
  message: string | null;
  postId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  gemini: number;
  tavily: number;
  imagesAi: number;
  calls?: Calls;
};

const STEPS: [string, string][] = [
  ["facts", "Reading the data"],
  ["writing", "Writing"],
  ["researching", "Researching"],
  ["checking", "Checking"],
  ["images", "Picking images"],
  ["saving", "Saving"],
];
const LABEL: Record<string, string> = { queued: "Queued", starting: "Starting", revising: "Revising", busy: "Waiting for Google", ...Object.fromEntries(STEPS) };
// Where "Revising" sits among the steps: it goes back to writing.
const STEP_OF: Record<string, string> = { revising: "writing" };
const ERRORS: Record<string, string> = {
  daily_cap: "Today's drafts are all used. More tomorrow (Pacific time).",
  production_only: "Drafts are written only on the live site.",
  no_gemini: "Staging has no Gemini key of its own yet, so it can't write drafts (DEPLOY.md, Staging).",
  no_workflow: "The draft writer isn't set up on this site.",
  workflow_failed: "The draft didn't start. Try again in a minute.",
  signin_required: "Your session ended. Sign in again.",
};
const OUTCOME: Record<string, string> = { done: "Done", dropped: "Dropped by the checks", skipped: "Not written", failed: "Failed" };

const secs = (from: string, to: number) => Math.max(0, Math.round((to - Date.parse(from)) / 1000));
const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export const isRunning = (job: Job | null): boolean => job != null && (job.status === "queued" || job.status === "running");

/** "Writing · 0:42" while it runs; "Done in 1:48" when it ended. */
export function jobLine(job: Job, now: number) {
  if (isRunning(job)) return `${LABEL[job.phase ?? "queued"] ?? job.phase ?? "Working"} · ${clockOf(secs(job.startedAt ?? job.createdAt, now))}`;
  return `${OUTCOME[job.status] ?? job.status}${job.finishedAt && job.startedAt ? ` in ${clockOf(secs(job.startedAt, Date.parse(job.finishedAt)))}` : ""}`;
}

/**
 * What a job spent, counting attempts and answers apart: Google may turn a
 * request away while busy (HTTP 503), which costs nothing but still counts
 * in our own daily budget, so both numbers show.
 */
export function spentLine(job: Job) {
  const c = job.calls;
  const gemini = c
    ? `Gemini: ${c.answered} answered${c.backup ? ` (${c.backup} by the backup model)` : ""}, ${c.attempts} attempt${c.attempts === 1 ? "" : "s"}${c.busy ? `, ${c.busy} turned away while Google was busy` : ""}`
    : `Gemini: ${job.gemini} requests`;
  return `${gemini}. Tavily: ${job.tavily} searches. AI images: ${job.imagesAi}.`;
}

/**
 * Polls a running job every 3 seconds and ticks the clock every second;
 * refreshes the page when it ends. `serverNow` is the server's clock for the
 * first render, so the server's HTML and the browser's first render agree.
 */
function useLiveJob(initial: Job | null, serverNow = 0) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(initial);
  const [now, setNow] = useState(serverNow);
  const running = isRunning(job);
  const id = job?.id;
  useEffect(() => {
    if (!running || !id) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/content/draft?id=${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = ((await res.json()) as { job: Job }).job;
        setJob(next);
        if (!isRunning(next)) router.refresh();
      } catch {
        // The next tick tries again.
      }
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [running, id, router]);
  return { job, now };
}

/** The first row of "Waiting for you" while a draft is being written. */
export function DraftInProgress({ initialJob, kindLabel, serverNow }: { initialJob: Job; kindLabel: string | null; serverNow: number }) {
  const { job, now } = useLiveJob(initialJob, serverNow);
  if (!job) return null;
  const running = isRunning(job);
  const busy = job.phase === "busy";
  const step = STEP_OF[job.phase ?? ""] ?? job.phase;
  const at = STEPS.findIndex(([k]) => k === step);
  return (
    <li id="in-progress" className="scroll-mt-24">
      <div className={`card flex items-start gap-4 p-3 sm:p-4 ${busy ? "ring-1 ring-inset ring-amber-500/40" : "ring-1 ring-inset ring-accent/30"}`} role="status" aria-live="polite" data-draft-in-progress>
        <span className="hidden h-[72px] w-32 shrink-0 items-center justify-center rounded-lg border border-dashed border-edge-strong bg-raised sm:flex">
          {running ? <span aria-hidden className="inline-block size-6 animate-spin rounded-full border-2 border-edge-strong border-t-accent" /> : <PenLine className="h-5 w-5 text-mute" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset ${busy ? "bg-amber-500/10 text-amber-600 ring-amber-500/30 dark:text-amber-400" : "bg-accent-soft text-accent ring-accent/30"}`}>
              {running && <span aria-hidden className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent sm:hidden" />}
              {running ? (busy ? "Waiting for Google" : "Being written") : (OUTCOME[job.status] ?? job.status)}
            </span>
            {kindLabel && <span className="text-xs text-mute">{kindLabel}</span>}
          </span>
          <span className="mt-1.5 block font-semibold leading-snug text-balance">{job.topic ? `New draft: ${job.topic}` : job.rewriteOf ? "Rewriting a draft with your notes" : "New draft"}</span>
          <span className="mt-1 block text-sm text-mute tabular-nums" data-draft-status>
            {jobLine(job, now)}
            {running && !busy && " · usually 1 to 3 minutes"}
          </span>
          {running && !busy && (
            <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Steps">
              {STEPS.map(([k, label], i) => (
                <li key={k} className={i < at ? "text-ink" : i === at ? "font-semibold text-accent" : "text-mute"} aria-current={i === at ? "step" : undefined}>
                  {i < at ? "✓ " : ""}
                  {label}
                </li>
              ))}
            </ol>
          )}
          {job.message && (busy || !running) && <span className={`mt-1.5 block text-sm ${busy ? "font-medium text-ink" : "text-mute"}`}>{job.message}</span>}
          {running && (
            <span className="mt-2 flex items-center gap-1.5 text-xs text-mute">
              <Server className="h-3.5 w-3.5 shrink-0" aria-hidden /> Runs on our server: you can refresh or leave this page, and the draft appears here when it is done.
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

export function DraftNow({ kinds, initialJob, left }: { kinds: { id: string; label: string; ready: boolean; reason: string | null }[]; initialJob: Job | null; left: number }) {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { job } = useLiveJob(initialJob);
  const running = isRunning(job);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/content/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: topic.trim() || null, kind: kind || null }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; job?: Job };
      if (!res.ok) setError(ERRORS[body.error ?? ""] ?? body.error ?? "That didn't work. Try again.");
      else {
        setTopic("");
        // The server renders the new job as the first row of "Waiting for you".
        router.push(`/admin/blog?job=${body.job!.id}#in-progress`);
        router.refresh();
      }
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="h-draft-now" className="@container rounded-xl border border-edge bg-card p-4">
      <h2 id="h-draft-now" className="text-lg font-bold tracking-tight">
        Write a draft now
      </h2>
      <p className="mt-1 text-sm text-mute">The same writer, research, images and checks as the night. It lands in Waiting for you, never on the blog by itself. {left} of 5 left today.</p>
      <div className="mt-3 grid gap-2 @xl:grid-cols-[1fr_auto_auto] @xl:items-end">
        <div>
          <label htmlFor="draft-topic" className="block text-sm font-semibold">
            Topic or angle <span className="font-normal text-mute">(optional)</span>
          </label>
          <input id="draft-topic" value={topic} onChange={(e) => setTopic(e.target.value.slice(0, 200))} maxLength={200} placeholder="Hero mistakes, showing projects..." className="mt-1 min-h-11 w-full rounded-lg border border-edge bg-raised px-3 text-sm outline-none focus:border-accent/60" />
        </div>
        <div>
          <label htmlFor="draft-kind" className="block text-sm font-semibold">
            From the data on
          </label>
          <select id="draft-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-edge bg-raised px-2 text-sm @xl:w-64">
            <option value="">The best fit (picked for you)</option>
            {kinds.map((k) => (
              <option key={k.id} value={k.id} disabled={!k.ready}>
                {k.label}
                {k.ready ? "" : " (not enough data yet)"}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={btnPrimary} disabled={busy || running || left < 1} onClick={start}>
          <PenLine className="h-4 w-4" aria-hidden /> {busy ? "Starting" : "Write a draft now"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-down">
          {error}
        </p>
      )}
      {running && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-edge bg-raised p-3 text-sm">
          <ArrowDown className="mt-0.5 h-4 w-4 shrink-0 text-accent xl:rotate-90" aria-hidden />
          <span>
            A draft is being written on our server. Follow it in{" "}
            <a href="#in-progress" className="font-semibold text-accent hover:underline">
              Waiting for you
            </a>
            ; refreshing or leaving this page doesn&apos;t stop it.
          </span>
        </p>
      )}
      {job && !running && (
        <div className="mt-4 rounded-lg border border-edge bg-raised p-3 text-sm" role="status" aria-live="polite" data-draft-status>
          <p className="font-semibold">Last draft: {jobLine(job, 0)}</p>
          {job.topic && <p className="mt-1 text-mute">Angle: {job.topic}</p>}
          {job.message && <p className="mt-1 text-mute">{job.message}</p>}
          {job.postId && (
            <Link href={`/admin/blog/${job.postId}`} className="mt-2 inline-flex min-h-9 items-center font-semibold text-accent hover:underline">
              Open the draft
            </Link>
          )}
          <p className="mt-1 text-xs text-mute">{spentLine(job)}</p>
        </div>
      )}
    </section>
  );
}
