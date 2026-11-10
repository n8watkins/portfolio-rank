"use client";

import { useEffect, useState } from "react";
import { Bot, CircleCheck, CircleX, EyeOff, Ruler } from "lucide-react";
import type { Scorecard } from "@/lib/preview/data";

const VIEW_KEY = "pr-details-view";

/** The scorecard with a Simple / Advanced switch (remembered in this browser). */
export function ScorecardPanel({
  card,
  hideScores = false,
  hiddenWhy,
  initialView,
  showTier = true,
}: {
  card: Scorecard;
  hideScores?: boolean;
  hiddenWhy?: string;
  initialView?: "simple" | "advanced";
  showTier?: boolean;
}) {
  const [view, setView] = useState<"simple" | "advanced">(initialView ?? "simple");
  useEffect(() => {
    if (initialView) return;
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "advanced" || v === "simple") setView(v);
    } catch {}
  }, [initialView]);
  const pick = (v: "simple" | "advanced") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const passed = card.facts.filter((f) => f.pass).length;
  const topFacts = [...card.facts].sort((a, b) => Number(a.pass) - Number(b.pass)).slice(0, 3);

  return (
    <div>
    <div role="radiogroup" aria-label="Detail level" className="grid w-full grid-cols-2 gap-1 rounded-lg border border-edge bg-raised p-1">
      {(["simple", "advanced"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          onClick={() => pick(v)}
          className="h-9 rounded-md text-sm font-medium capitalize text-mute aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-[var(--card-hi),var(--card-drop)]"
        >
          {v}
        </button>
      ))}
    </div>

    {hideScores ? (
      <p className="mt-4 flex items-start gap-2 rounded-xl border border-dashed border-edge-strong p-3 text-sm text-mute">
        <EyeOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {hiddenWhy ?? "Scores are hidden for now."}
      </p>
    ) : !showTier ? null : (
      <div className="mt-4 flex items-center gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-2xl font-bold text-accent ring-1 ring-inset ring-accent/25">{card.tier}</span>
        <p className="text-sm">
          <span className="block font-semibold">AI tier {card.tier}</span>
          <span className="block text-mute">{card.verdict}</span>
        </p>
      </div>
    )}

    {view === "simple" ? (
      <>
        <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <Ruler className="h-4 w-4 text-mute" aria-hidden /> Checked by code
          <span className="font-normal text-mute">
            {passed} of {card.facts.length} passed
          </span>
        </h3>
        <ul className="mt-2 grid gap-1.5 text-sm">
          {topFacts.map((f) => (
            <Fact key={f.label} f={f} />
          ))}
        </ul>
        {hideScores && (
          <p className="mt-4 text-sm">
            <span className="font-semibold">In one line: </span>
            <span className="text-mute">{[...card.subs].sort((a, b) => b.value - a.value)[0].note}</span>
          </p>
        )}
        <button type="button" onClick={() => pick("advanced")} className="mt-4 text-sm font-semibold text-accent hover:underline">
          Every check and score
        </button>
      </>
    ) : (
      <>
        <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <Ruler className="h-4 w-4 text-mute" aria-hidden /> Checked by code
        </h3>
        <ul className="mt-2 grid gap-1.5 text-sm">
          {card.facts.map((f) => (
            <Fact key={f.label} f={f} />
          ))}
        </ul>
        <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-mute" aria-hidden /> Judged by Gemini
        </h3>
        <ul className="mt-2 divide-y divide-edge text-sm">
          {card.subs.map((s) => (
            <li key={s.label} className="py-2">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.label}</span>
                {hideScores ? (
                  <span className="text-xs text-mute">hidden</span>
                ) : (
                  <span className="tabular-nums">
                    <strong>{s.value}</strong>
                    <span className="text-mute">/5</span>
                  </span>
                )}
              </span>
              <span className="block text-mute">{s.note}</span>
            </li>
          ))}
        </ul>
      </>
    )}
    <p className="mt-5 text-xs text-mute">Facts and grades are sample data in this preview.</p>
    </div>
  );
}

function Fact({ f }: { f: { label: string; pass: boolean; detail: string } }) {
  return (
    <li className="flex items-center gap-2">
      {f.pass ? <CircleCheck className="h-4 w-4 shrink-0 text-up" aria-label="Pass" /> : <CircleX className="h-4 w-4 shrink-0 text-down" aria-label="Fail" />}
      <span className="min-w-0 flex-1 truncate">{f.label}</span>
      <span className="shrink-0 truncate text-xs text-mute">{f.detail}</span>
    </li>
  );
}
