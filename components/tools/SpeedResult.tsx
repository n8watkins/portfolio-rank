"use client";

import { useState } from "react";
import { CircleAlert, Clock, Laptop, Smartphone } from "lucide-react";
import type { PsiResult } from "@/lib/tools/psi";

export type SpeedAnswer = {
  url: string;
  listed: boolean;
  profile?: string;
  mobile: PsiResult;
  desktop: PsiResult;
  discovery: { status: string; added: boolean } | null;
};

const CATEGORY_LABELS: [string, string][] = [
  ["performance", "Performance"],
  ["accessibility", "Accessibility"],
  ["best-practices", "Best practices"],
  ["seo", "SEO"],
];

/** What each Core Web Vital means to a visitor, and Google's "good" line. */
const METRIC_WORDS: Record<string, { short: string; means: string }> = {
  "largest-contentful-paint": { short: "LCP", means: "When the main content shows up. Good is under 2.5 s." },
  "first-contentful-paint": { short: "FCP", means: "When anything first appears on screen. Good is under 1.8 s." },
  "total-blocking-time": { short: "TBT", means: "How long the page ignores taps while scripts run. Good is under 200 ms." },
  "cumulative-layout-shift": { short: "CLS", means: "How much the layout jumps while loading. Good is under 0.1." },
  "speed-index": { short: "SI", means: "How quickly the visible page fills in. Good is under 3.4 s." },
};

const ERROR_WORDS: Record<string, string> = {
  quota: "Google's free speed checks are used up for today. Try again tomorrow.",
  unreachable: "Lighthouse couldn't load this page. Check that it opens in a private window.",
  timeout: "The site took too long to load for Lighthouse.",
};

type Tone = "good" | "fair" | "poor" | "none";
const toneOf = (score: number | null | undefined): Tone => (score == null ? "none" : score >= 90 ? "good" : score >= 50 ? "fair" : "poor");
const metricTone = (score: number | null | undefined): Tone => (score == null ? "none" : score >= 0.9 ? "good" : score >= 0.5 ? "fair" : "poor");
const TONE_TEXT: Record<Tone, string> = { good: "text-up", fair: "text-accent", poor: "text-down", none: "text-mute" };
const TONE_BG: Record<Tone, string> = { good: "bg-up", fair: "bg-accent", poor: "bg-down", none: "bg-mute" };

function ScoreRing({ score, label }: { score: number | null | undefined; label: string }) {
  const tone = toneOf(score);
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = score == null ? 0 : (score / 100) * c;
  return (
    <figure className="flex flex-col items-center gap-2 text-center">
      <div className={`relative h-[84px] w-[84px] ${TONE_TEXT[tone]}`}>
        <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90" aria-hidden>
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-edge" />
          <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" strokeLinecap="round" stroke="currentColor" strokeDasharray={`${filled} ${c}`} />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-2xl font-bold tabular-nums">{score ?? "-"}</span>
      </div>
      <figcaption className="text-sm font-medium">
        {label}
        <span className="sr-only">: {score == null ? "not measured" : `${score} out of 100`}</span>
      </figcaption>
    </figure>
  );
}

function measuredOn(at?: string) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One device's result: scores, the vitals in plain words and the fixes, biggest win first. */
function Device({ r }: { r: PsiResult }) {
  if (!r.ok) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-edge bg-raised/50 p-4 text-sm">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
        {ERROR_WORDS[r.error ?? ""] ?? "We couldn't check this one. Try again in a few minutes."}
      </p>
    );
  }
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-y-6 sm:grid-cols-4">
        {CATEGORY_LABELS.map(([id, label]) => (
          <ScoreRing key={id} score={r.scores?.[id]} label={label} />
        ))}
      </div>

      {r.metrics && r.metrics.length > 0 && (
        <section aria-label="Core Web Vitals">
          <h3 className="text-sm font-semibold">How it feels to a visitor</h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {r.metrics.map((m) => {
              const words = METRIC_WORDS[m.id];
              const tone = metricTone(m.score);
              return (
                <li key={m.id} className="rounded-xl border border-edge bg-card p-3.5">
                  <p className="flex items-center gap-2 text-xs font-medium text-mute">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_BG[tone]}`} aria-hidden />
                    {m.label}
                  </p>
                  <p className={`mt-1 whitespace-nowrap text-xl font-bold tabular-nums ${TONE_TEXT[tone]}`}>{m.value}</p>
                  {words && <p className="mt-1 text-xs text-mute">{words.means}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="What to fix">
        <h3 className="text-sm font-semibold">Fix these first</h3>
        {r.fixes && r.fixes.length > 0 ? (
          <ol className="mt-3 space-y-2">
            {r.fixes.map((f, i) => (
              <li key={f.id} className="flex gap-3 rounded-xl border border-edge bg-card p-4">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent">{i + 1}</span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-medium">
                    {f.title}
                    {f.savings && <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-mute">{f.savings}</span>}
                  </p>
                  <p className="mt-1 text-sm text-mute">{f.tip}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-mute">Nothing big to fix here. Nice work.</p>
        )}
      </section>
    </div>
  );
}

/** The speed check's answer, with a Mobile / Desktop switch (mobile first: that is what Google ranks on). */
export function SpeedResult({ answer }: { answer: SpeedAnswer }) {
  const [view, setView] = useState<"mobile" | "desktop">("mobile");
  const r = answer[view];
  const when = measuredOn(answer.mobile.measuredAt ?? answer.desktop.measuredAt);
  const tabs = [
    { id: "mobile" as const, label: "Mobile", Icon: Smartphone, score: answer.mobile.scores?.performance },
    { id: "desktop" as const, label: "Desktop", Icon: Laptop, score: answer.desktop.scores?.performance },
  ];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Device" className="inline-flex rounded-xl border border-edge bg-raised/60 p-1">
          {tabs.map(({ id, label, Icon, score }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className="inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-mute transition hover:text-ink aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-[var(--card-hi),var(--card-drop)]"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
              {score != null && <span className={`tabular-nums font-semibold ${TONE_TEXT[toneOf(score)]}`}>{score}</span>}
            </button>
          ))}
        </div>
        {when && (
          <p className="inline-flex items-center gap-1.5 text-xs text-mute">
            <Clock className="h-3.5 w-3.5" aria-hidden /> Lighthouse via Google PageSpeed, {when}
          </p>
        )}
      </div>
      <div role="tabpanel" className="mt-6">
        <Device r={r} />
      </div>
    </div>
  );
}
