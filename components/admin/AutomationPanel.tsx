"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { CalendarClock, CircleAlert, CircleCheck, History, ListOrdered, TriangleAlert, X } from "lucide-react";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

// The blog's automation on /admin/blog (lib/content/automation.mjs, POST
// /api/admin/content/automation): on or off, the drafting nights, drafts a
// week, drafts for review or publishing automatically, the topic queue, and
// when the next and last scheduled runs are. The Worker's config is the
// ceiling: what it keeps off shows as off here, with the reason.

export type AutomationSettings = { enabled: boolean; mode: "review" | "publish"; days: number[]; perWeek: number; engineMode?: string };
export type AutomationView = {
  settings: AutomationSettings | null;
  bounds: { maxMode: string; maxPerWeek: number; canPublish: boolean; canRun: boolean };
  saved: { at: string; by: string | null } | null;
  topics: { queued: { id: number; topic: string }[]; used: { id: number; topic: string; status: string; usedAt: string | null; postId: string | null }[] };
  next: { date: string; weekday: number; label: string } | null;
  last: { night: string; step: string; status: string; kind: string | null; postId: string | null; stored: string | null; reason: string | null; picks: string[] | null } | null;
  doneThisWeek: number;
  problem: string | null;
};

const DAYS = [
  [1, "Mon", "Monday"],
  [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"],
  [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"],
  [6, "Sat", "Saturday"],
] as const;

const dayList = (days: number[]) => {
  const names = days.map((d) => DAYS.find((x) => x[0] === d)?.[2] ?? "").filter(Boolean);
  return names.length <= 1 ? (names[0] ?? "no day") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

function lastLine(last: AutomationView["last"], kindLabel: (k: string) => string) {
  if (!last) return "None yet: no scheduled pick or draft has run.";
  const night = new Date(`${last.night}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (last.step === "pick") return `${night} night: picked this week's ideas${last.picks?.length ? ` (${last.picks.map(kindLabel).join(", ")})` : ""}.`;
  const what = last.kind ? kindLabel(last.kind) : "a draft";
  const result =
    last.status === "ok"
      ? last.stored === "published"
        ? "published"
        : "kept for your review"
      : last.status === "dropped"
        ? "dropped by the checks"
        : last.status === "deferred"
          ? "put off: not enough Gemini left"
          : last.status === "skipped"
            ? "skipped"
            : "failed";
  return `${night} night: ${what}, ${result}${last.reason ? ` (${last.reason})` : ""}.`;
}

export function AutomationPanel({ initial, kindLabels }: { initial: AutomationView; kindLabels: Record<string, string> }) {
  const id = useId();
  const [view, setView] = useState(initial);
  const start = view.settings ?? { enabled: false, mode: "review" as const, days: [1, 3], perWeek: 1 };
  const [form, setForm] = useState<AutomationSettings>({ enabled: start.enabled, mode: start.mode, days: start.days, perWeek: Math.max(1, start.perWeek) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [topic, setTopic] = useState("");
  const [topicError, setTopicError] = useState<string | null>(null);
  const b = view.bounds;
  const kindLabel = (k: string) => kindLabels[k] ?? k;

  const dirty = useMemo(() => {
    const s = view.settings;
    if (!s) return true;
    return s.enabled !== form.enabled || s.mode !== form.mode || s.perWeek !== form.perWeek || s.days.join() !== form.days.join();
  }, [view.settings, form]);
  const maxPerWeek = Math.max(1, Math.min(b.maxPerWeek, Math.max(1, form.days.length)));

  const post = async (body: unknown) => {
    const res = await fetch("/api/admin/content/automation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.message ?? (res.status === 401 ? "Your session ended. Sign in again." : "That didn't work. Try again."));
    setView(out as AutomationView);
    return out as AutomationView;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const v = await post({ op: "save", settings: { ...form, perWeek: Math.min(form.perWeek, maxPerWeek) } });
      if (v.settings) setForm({ enabled: v.settings.enabled, mode: v.settings.mode, days: v.settings.days, perWeek: Math.max(1, v.settings.perWeek) });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const status = !b.canRun
    ? "Off in the Worker's config"
    : !view.settings
      ? "Paused: the settings can't be read"
      : view.settings.enabled
        ? `On: ${view.settings.perWeek} ${view.settings.perWeek === 1 ? "draft" : "drafts"} a week on ${dayList(view.settings.days)} nights, ${view.settings.mode === "publish" ? "published automatically" : "for your review"}`
        : "Off";

  return (
    <section aria-labelledby={`${id}-t`} className="card @container p-5 sm:p-6" data-automation>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-t`} className="text-lg font-bold tracking-tight">
            Automation
          </h2>
          <p className="mt-0.5 text-sm text-mute" role="status">
            {status}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          aria-label="Scheduled drafts"
          disabled={!b.canRun || busy}
          onClick={() => {
            setSaved(false);
            setForm((f) => ({ ...f, enabled: !f.enabled }));
          }}
          className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition disabled:opacity-50 ${form.enabled ? "bg-up" : "bg-edge-strong"}`}
        >
          <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transition ${form.enabled ? "translate-x-7" : "translate-x-1"}`} />
        </button>
      </div>

      {view.problem && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-down/40 bg-down/5 p-3 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden /> {view.problem}
        </p>
      )}
      {!b.canRun && (
        <p className="mt-3 text-sm text-mute">CONTENT_MODE is &quot;off&quot; in wrangler.jsonc, so nothing is written whatever is set here. Changing that takes a pull request.</p>
      )}

      <fieldset disabled={!b.canRun || busy} className={`mt-5 grid gap-5 ${form.enabled ? "" : "opacity-60"}`}>
        <div>
          <legend className="text-sm font-semibold">Nights</legend>
          <p className="text-xs text-mute">The night run starts at 20:30 Pacific; one draft a night at most. Sunday night picks the week&apos;s ideas.</p>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Nights">
            {DAYS.map(([d, short, long]) => {
              const on = form.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={long}
                  onClick={() => {
                    setSaved(false);
                    setForm((f) => {
                      const days = on ? f.days.filter((x) => x !== d) : [...f.days, d].sort((a, z) => a - z);
                      return { ...f, days, perWeek: Math.max(1, Math.min(f.perWeek, Math.max(1, days.length), b.maxPerWeek)) };
                    });
                  }}
                  className={`h-11 min-w-12 rounded-lg border px-3 text-sm font-semibold transition ${on ? "border-accent bg-accent-soft text-accent" : "border-edge bg-card text-mute hover:border-edge-strong"}`}
                >
                  {short}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p id={`${id}-pw`} className="text-sm font-semibold">
            Drafts a week
          </p>
          <p className="text-xs text-mute">At most {b.maxPerWeek} (CONTENT_DRAFTS_PER_WEEK), and no more than the nights you pick.</p>
          <div className="mt-2 inline-flex rounded-lg border border-edge bg-raised p-1" role="radiogroup" aria-labelledby={`${id}-pw`}>
            {Array.from({ length: Math.max(1, b.maxPerWeek) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={form.perWeek === n}
                disabled={n > maxPerWeek}
                onClick={() => {
                  setSaved(false);
                  setForm((f) => ({ ...f, perWeek: n }));
                }}
                className={`h-9 min-w-11 rounded-md px-3 text-sm font-semibold transition disabled:opacity-40 ${form.perWeek === n ? "bg-card text-ink shadow-sm" : "text-mute"}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div role="radiogroup" aria-labelledby={`${id}-mode`}>
          <p id={`${id}-mode`} className="text-sm font-semibold">
            Mode
          </p>
          <div className="mt-2 grid gap-2 @lg:grid-cols-2">
            {(
              [
                ["review", "Drafts for my review", "Each draft waits here until you publish, rewrite or reject it."],
                ["publish", "Publish automatically", b.canPublish ? "A draft that passes every check and the scorecard goes live at the next 08:00 Pacific." : 'Needs CONTENT_MODE "publish" in wrangler.jsonc (a pull request).'],
              ] as const
            ).map(([value, label, hint]) => {
              const on = form.mode === value;
              const off = value === "publish" && !b.canPublish;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={off}
                  onClick={() => {
                    setSaved(false);
                    setForm((f) => ({ ...f, mode: value }));
                  }}
                  className={`rounded-xl border p-3.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${on ? "border-accent bg-accent-soft" : "border-edge bg-card hover:border-edge-strong"}`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <span className={`grid h-4 w-4 place-items-center rounded-full border-2 ${on ? "border-accent" : "border-edge-strong"}`} aria-hidden>
                      {on && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </span>
                    {label}
                  </span>
                  <span className="mt-1 block text-xs text-mute">{hint}</span>
                </button>
              );
            })}
          </div>
          {form.mode === "publish" && (
            <p role="note" className="mt-2 flex items-start gap-2 rounded-lg border border-down/40 bg-down/5 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-down" aria-hidden />
              <span>
                Posts go live without you reading them first. The limits still hold: at most 2 published in any 7 days, only drafts with a clean scorecard (anything flagged waits here), and only at 08:00 Pacific. You can still unpublish a post from its page.
              </span>
            </p>
          )}
        </div>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={!dirty || busy || !b.canRun} className={btnPrimary}>
          {busy ? "Saving..." : "Save automation"}
        </button>
        {saved && !dirty && (
          <span role="status" className="inline-flex items-center gap-1.5 text-sm text-up">
            <CircleCheck className="h-4 w-4" aria-hidden /> Saved. It applies from tonight&apos;s run.
          </span>
        )}
        {error && (
          <span role="alert" className="text-sm text-down">
            {error}
          </span>
        )}
        {view.saved && !saved && <span className="text-xs text-mute">Last changed {new Date(view.saved.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" })} Pacific</span>}
      </div>

      <dl className="mt-5 grid gap-3 border-t border-edge pt-4 text-sm @lg:grid-cols-2">
        <div className="flex gap-2.5">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
          <div>
            <dt className="font-semibold">Next run</dt>
            <dd className="text-mute">
              {view.next ? `${view.next.label}${view.topics.queued[0] ? `, on "${view.topics.queued[0].topic}"` : ", on the week's best idea"}.` : "None: the automation is off."}
              {view.next && <span className="block text-xs">{view.doneThisWeek} of this week&apos;s drafts done.</span>}
            </dd>
          </div>
        </div>
        <div className="flex gap-2.5">
          <History className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
          <div>
            <dt className="font-semibold">Last run</dt>
            <dd className="text-mute">
              {lastLine(view.last, kindLabel)}{" "}
              {view.last?.postId && (
                <Link href={`/admin/blog/${view.last.postId}`} className="font-semibold text-accent hover:underline">
                  Open it
                </Link>
              )}
            </dd>
          </div>
        </div>
      </dl>

      <div className="mt-5 border-t border-edge pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ListOrdered className="h-4 w-4 text-mute" aria-hidden /> Topic queue
        </h3>
        <p className="text-xs text-mute">Optional. The next scheduled draft takes the first topic instead of choosing its own angle; the week&apos;s data still decides what it&apos;s written from.</p>
        <form
          className="mt-2 flex flex-col gap-2 @lg:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!topic.trim()) return;
            setTopicError(null);
            try {
              await post({ op: "add-topic", topic });
              setTopic("");
            } catch (err) {
              setTopicError((err as Error).message);
            }
          }}
        >
          <label htmlFor={`${id}-topic`} className="sr-only">
            New topic
          </label>
          <input
            id={`${id}-topic`}
            value={topic}
            maxLength={200}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Why a resume link beats a contact form"
            className="h-11 w-full min-w-0 rounded-lg border border-edge-strong bg-card px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 @lg:flex-1"
          />
          <button type="submit" className={btnSecondary} disabled={!topic.trim()}>
            Add topic
          </button>
        </form>
        {topicError && (
          <p role="alert" className="mt-1.5 text-sm text-down">
            {topicError}
          </p>
        )}
        {view.topics.queued.length > 0 ? (
          <ol className="mt-3 grid gap-1.5">
            {view.topics.queued.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg border border-edge bg-raised/60 px-3 py-2 text-sm">
                <span className="w-5 shrink-0 text-xs font-bold text-mute tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">{t.topic}</span>
                <button
                  type="button"
                  aria-label={`Remove "${t.topic}"`}
                  onClick={() => post({ op: "remove-topic", id: t.id }).catch((err) => setTopicError((err as Error).message))}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mute hover:bg-card hover:text-ink"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-mute">No topics queued: each draft picks the week&apos;s best idea.</p>
        )}
        {view.topics.used.length > 0 && (
          <p className="mt-3 text-xs text-mute">
            Used:{" "}
            {view.topics.used.slice(0, 3).map((t, i) => (
              <span key={t.id}>
                {i > 0 && "; "}
                {t.postId ? (
                  <Link href={`/admin/blog/${t.postId}`} className="hover:text-ink hover:underline">
                    {t.topic}
                  </Link>
                ) : (
                  t.topic
                )}
                {t.status === "dropped" ? " (dropped)" : ""}
              </span>
            ))}
          </p>
        )}
      </div>
    </section>
  );
}
