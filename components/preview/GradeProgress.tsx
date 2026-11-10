"use client";

import { useEffect, useState } from "react";
import { ArrowRight, CircleCheck, Circle } from "lucide-react";
import { SampleTag, btnPrimary, card } from "@/components/preview/bits";

const STEPS = [
  { label: "Opening the page and taking screenshots", ms: 1400 },
  { label: "Measuring: resume, GitHub, links, domain, speed", ms: 1600 },
  { label: "Gemini looks at design, first impression and writing", ms: 2000 },
];

/** Live progress for an instant grade (timed mock). */
export function GradeProgress({ url, reportHref }: { url: string; reportHref: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (step >= STEPS.length) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEPS[step].ms);
    return () => clearTimeout(t);
  }, [step]);
  const done = step >= STEPS.length;
  return (
    <section aria-labelledby="progress" className={`${card} p-5 sm:p-7`}>
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
        Grading <SampleTag what="Simulated progress" />
      </p>
      <h1 id="progress" className="mt-1 break-all text-2xl font-bold tracking-tight">
        {url.replace(/^https?:\/\//, "")}
      </h1>
      <div className="mt-5 h-2 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(step / STEPS.length) * 100}%` }} />
      </div>
      <ol className="mt-5 grid grid-cols-1 gap-3" aria-live="polite">
        {STEPS.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3 text-sm">
            {i < step ? (
              <CircleCheck className="h-5 w-5 shrink-0 text-up" aria-hidden />
            ) : i === step ? (
              <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
                <span className="attn-dot" />
              </span>
            ) : (
              <Circle className="h-5 w-5 shrink-0 text-edge" aria-hidden />
            )}
            <span className={i === step ? "font-semibold" : i < step ? "" : "text-mute"}>{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="mt-6 min-h-11">
        {done ? (
          <a href={reportHref} className={btnPrimary}>
            See your report <ArrowRight className="h-4 w-4" aria-hidden />
          </a>
        ) : (
          <p className="text-sm text-mute">Usually under a minute. You can leave; the report keeps its link.</p>
        )}
      </div>
    </section>
  );
}
