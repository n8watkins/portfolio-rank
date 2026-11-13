"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";

// "Write a draft now" (POST /api/admin/content/draft): an optional topic or
// angle and story, then the live status of the draft while the Workflow
// writes it, polled every few seconds from GET /api/admin/content/draft?id=.

export type Job = { id: string; kind: string | null; topic: string | null; rewriteOf: string | null; status: string; phase: string | null; message: string | null; postId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; gemini: number; tavily: number; imagesAi: number };

const STEPS: [string, string][] = [
  ["facts", "Reading the data"],
  ["writing", "Writing"],
  ["researching", "Researching"],
  ["checking", "Checking"],
  ["images", "Picking images"],
  ["saving", "Saving"],
];
const LABEL: Record<string, string> = { queued: "Queued", starting: "Starting", revising: "Revising", ...Object.fromEntries(STEPS) };
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

/** The live status line of one job: "Writing... 0:42 (usually 1 to 3 minutes)". */
export function jobLine(job: Job, now: number) {
  if (job.status === "queued" || job.status === "running") {
    const label = LABEL[job.phase ?? "queued"] ?? job.phase ?? "Working";
    return `${label}... ${clockOf(secs(job.startedAt ?? job.createdAt, now))} (usually 1 to 3 minutes)`;
  }
  return `${OUTCOME[job.status] ?? job.status}${job.finishedAt && job.startedAt ? ` in ${clockOf(secs(job.startedAt, Date.parse(job.finishedAt)))}` : ""}`;
}

export function DraftNow({ kinds, initialJob, left }: { kinds: { id: string; label: string; ready: boolean; reason: string | null }[]; initialJob: Job | null; left: number }) {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState("");
  const [job, setJob] = useState<Job | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = job != null && (job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!running || !job) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const res = await fetch(`/api/admin/content/draft?id=${job.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = ((await res.json()) as { job: Job }).job;
        setJob(next);
        if (next.status !== "queued" && next.status !== "running") router.refresh();
      } catch {
        // The next tick tries again.
      }
    }, 3000);
    return () => clearInterval(t);
  }, [running, job, router]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/content/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: topic.trim() || null, kind: kind || null }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; job?: Job };
      if (!res.ok) setError(ERRORS[body.error ?? ""] ?? body.error ?? "That didn't work. Try again.");
      else {
        setJob(body.job!);
        setNow(Date.now());
        setTopic("");
        router.refresh();
      }
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const at = running ? STEPS.findIndex(([k]) => k === job?.phase) : -1;
  return (
    <section aria-labelledby="h-draft-now" className="rounded-xl border border-edge bg-card p-4">
      <h2 id="h-draft-now" className="text-lg font-bold tracking-tight">
        Write a draft now
      </h2>
      <p className="mt-1 text-sm text-mute">The same writer, research, images and checks as the night. It lands in Waiting for you, never on the blog by itself. {left} of 5 left today.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
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
          <select id="draft-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-edge bg-raised px-2 text-sm sm:w-64">
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
      {job && (
        <div className="mt-4 rounded-lg border border-edge bg-raised p-3 text-sm" role="status" aria-live="polite" data-draft-status>
          <p className="font-semibold">
            {running && <span aria-hidden className="mr-2 inline-block size-3.5 animate-spin rounded-full border-2 border-edge-strong border-t-accent align-[-2px]" />}
            {jobLine(job, now)}
          </p>
          {running && (
            <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Steps">
              {STEPS.map(([k, label], i) => (
                <li key={k} className={i < at ? "text-ink" : i === at ? "font-semibold text-accent" : "text-mute"}>
                  {i < at ? "✓ " : ""}
                  {label}
                </li>
              ))}
            </ol>
          )}
          {job.topic && <p className="mt-1 text-mute">Angle: {job.topic}</p>}
          {job.message && <p className="mt-1 text-mute">{job.message}</p>}
          {!running && job.postId && (
            <Link href={`/admin/blog/${job.postId}`} className="mt-2 inline-flex min-h-9 items-center font-semibold text-accent hover:underline">
              Open the draft
            </Link>
          )}
          {!running && <p className="mt-1 text-xs text-mute">Spent: {job.gemini} Gemini requests, {job.tavily} Tavily searches, {job.imagesAi} AI images.</p>}
        </div>
      )}
    </section>
  );
}
