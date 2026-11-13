"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, CircleCheck, Gauge, Link2, Loader2, Search, Sparkles, Trophy } from "lucide-react";
import { ROUTES } from "@/lib/nav";
import type { ToolId } from "@/lib/tools/catalog";
import { btnPrimary } from "@/components/ui/styles";
import { useToolRequest } from "@/components/tools/useToolRequest";
import { SpeedResult, type SpeedAnswer } from "@/components/tools/SpeedResult";

const LOOKS_LIKE_URL = /^(https?:\/\/)?[^\s./]+\.[^\s]{2,}$/;

/** Where each tool posts. */
const ENDPOINT: Partial<Record<ToolId, string>> = { speed: "/api/tools/speed" };

const STEPS: Record<ToolId, string[]> = {
  speed: ["Loading your site on a phone", "Loading it on a desktop", "Scoring speed, accessibility and SEO"],
  share: ["Reading your share card"],
  checklist: ["Checking resume, GitHub, contact and links"],
};

type Answers = Partial<Record<ToolId, unknown>>;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A minute-long wait, told honestly: what's happening and how long it has been. */
function Running({ tools, since }: { tools: ToolId[]; since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const steps = tools.flatMap((t) => STEPS[t]);
  // Each step lights up in turn over the usual minute; the last stays on until the answer comes.
  const at = Math.min(steps.length - 1, Math.floor(secs / (50 / steps.length)));
  return (
    <div role="status" aria-live="polite" className="card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> Checking your portfolio
        </p>
        <span className="text-sm tabular-nums text-mute">{secs}s</span>
      </div>
      <ol className="mt-4 space-y-2.5">
        {steps.map((s, i) => (
          <li key={s} className={`flex items-center gap-2.5 text-sm transition ${i <= at ? "text-ink" : "text-mute/70"}`}>
            {i < at ? <CircleCheck className="h-4 w-4 text-up" aria-hidden /> : <span className={`h-2 w-2 rounded-full ${i === at ? "attn-dot bg-accent" : "bg-edge-strong"} mx-1`} aria-hidden />}
            {s}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-mute">Lighthouse loads the whole page twice, so this takes about a minute. You can keep reading meanwhile.</p>
    </div>
  );
}

/** What happened to the results: saved to a listed profile, or queued for PortfolioRank. */
function Saved({ answer }: { answer: SpeedAnswer }) {
  const host = hostOf(answer.url);
  if (answer.listed && answer.profile) {
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-hidden />
        <span>
          <span className="font-semibold">{host}</span> is on PortfolioRank. These results are saved to its profile.
        </span>
        <a href={answer.profile} className="group inline-flex items-center gap-1 font-semibold text-accent">
          See the profile <ArrowRight className="nudge h-4 w-4" aria-hidden />
        </a>
      </p>
    );
  }
  if (answer.discovery) {
    return (
      <p className="flex items-start gap-3 text-sm">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-up" aria-hidden />
        <span>
          <span className="font-semibold">{host}</span> {answer.discovery.added ? "is now in line to join PortfolioRank" : "is already in line to join PortfolioRank"}. We grade it when
          there&apos;s room in the day&apos;s free quota, and it stays private until then.
        </span>
      </p>
    );
  }
  return null;
}

/**
 * "Check my portfolio": one address, every tool in `tools`, one run. The
 * results are saved (lib/tools): to the profile of a listed portfolio, or,
 * with "Add my portfolio" on, alongside a place in the discovery queue.
 */
export function PortfolioCheck({ tools, initialUrl = "", cta = "Check my portfolio" }: { tools: ToolId[]; initialUrl?: string; cta?: string }) {
  const id = useId();
  const [url, setUrl] = useState(initialUrl);
  const [addToList, setAddToList] = useState(true);
  const [error, setError] = useState("");
  const [since, setSince] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [checked, setChecked] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const { arm, post, turnstile } = useToolRequest();
  const busy = since !== null;

  const run = async (raw: string) => {
    const v = raw.trim();
    if (!LOOKS_LIKE_URL.test(v)) {
      setError("Paste your portfolio's address, like yourname.dev.");
      return;
    }
    setError("");
    setAnswers(null);
    setSince(Date.now());
    try {
      const out: Answers = {};
      // One token per request: the tools run one after another.
      for (const t of tools) {
        const path = ENDPOINT[t];
        if (!path) continue;
        const r = await post<unknown>(path, { url: v, addToList });
        if (!r.ok) {
          setError(r.message);
          if (Object.keys(out).length === 0) return;
          break;
        }
        out[t] = r.data;
      }
      setAnswers(out);
      setChecked(v);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("url", v);
        window.history.replaceState(null, "", u);
      } catch {}
      requestAnimationFrame(() => results.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } finally {
      setSince(null);
    }
  };

  const speed = answers?.speed as SpeedAnswer | undefined;
  const gradeHref = ROUTES.grade ? `${ROUTES.grade}?url=${encodeURIComponent(checked)}` : ROUTES.top;

  return (
    <div>
      <form
        noValidate
        onFocus={arm}
        onPointerEnter={arm}
        onSubmit={(e) => {
          e.preventDefault();
          void run(url);
        }}
        aria-busy={busy}
        className="w-full"
      >
        <label htmlFor={`${id}-url`} className="sr-only">
          Your portfolio address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
            <input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="yourname.dev"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError("");
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              className="h-12 w-full rounded-lg border border-edge bg-card pl-10 pr-3 text-[15px] outline-none transition placeholder:text-mute/80 focus:border-accent"
            />
          </div>
          <button type="submit" disabled={busy} className={`${btnPrimary} h-12 px-6 text-[15px]`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
            {busy ? "Checking" : cta}
          </button>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-down">
            {error}
          </p>
        )}
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-left text-sm">
          <input type="checkbox" checked={addToList} onChange={(e) => setAddToList(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-fill)]" />
          <span>
            <span className="font-medium">Add my portfolio to PortfolioRank</span>
            <span className="block text-xs text-mute">
              If it isn&apos;t listed yet, we save these results and grade it when there&apos;s room. Nothing is public until it&apos;s graded, and you can remove it any time.
            </span>
          </span>
        </label>
        {turnstile}
      </form>

      <div ref={results} className="scroll-mt-24">
        {busy && since !== null && (
          <div className="mt-8">
            <Running tools={tools} since={since} />
          </div>
        )}
        {speed && (
          <div className="mt-10 space-y-6 text-left">
            <div className="card p-5 sm:p-7">
              <div className="mb-6 flex flex-wrap items-center gap-3">
                <span className="icon-tile h-10 w-10">
                  <Gauge className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold tracking-tight">Speed and Lighthouse</h2>
                  <p className="truncate text-sm text-mute">{hostOf(speed.url)}</p>
                </div>
              </div>
              <SpeedResult answer={speed} />
            </div>
            <div className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="min-w-0">
                <Saved answer={speed} />
                <p className="mt-2 flex items-start gap-3 text-sm text-mute">
                  <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  Speed is one part. Get a full grade, see where you&apos;d rank among real developer portfolios, and the three things to fix first.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <a href={gradeHref ?? "/top"} className={btnPrimary}>
                  <Sparkles className="h-4 w-4" aria-hidden /> See how you rank
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
