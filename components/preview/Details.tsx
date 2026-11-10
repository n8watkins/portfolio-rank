"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, CircleCheck, CircleX, EyeOff, ExternalLink, PanelRightOpen, Ruler, X } from "lucide-react";
import type { Scorecard } from "@/lib/preview/data";

const VIEW_KEY = "pr-details-view";

type Props = {
  name: string;
  domain: string;
  url: string;
  shot: string;
  card: Scorecard;
  /** Hide the tier and 1-5 scores (quiz before guessing, face-off before voting). */
  hideScores?: boolean;
  hiddenWhy?: string;
  compact?: boolean;
  /** Open on load (screenshots). */
  initialOpen?: boolean;
  initialView?: "simple" | "advanced";
};

/** "Details": a large scrollable preview of the whole page plus its scorecard. */
export function Details({ name, domain, url, shot, card, hideScores = false, hiddenWhy, compact = false, initialOpen = false, initialView }: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [view, setView] = useState<"simple" | "advanced">(initialView ?? "simple");
  const [full, setFull] = useState(true);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (initialView) return;
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "advanced" || v === "simple") setView(v);
    } catch {}
  }, [initialView]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      document.documentElement.style.overflow = "hidden";
    }
    if (!open && d.open) d.close();
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);

  const pick = (v: "simple" | "advanced") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  const passed = card.facts.filter((f) => f.pass).length;
  const topFacts = [...card.facts].sort((a, b) => Number(a.pass) - Number(b.pass)).slice(0, 3);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-edge bg-card font-semibold text-ink shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-95 ${compact ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm"}`}
        aria-haspopup="dialog"
      >
        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden /> <span className={compact ? "max-sm:sr-only" : ""}>Details</span>
      </button>
      <dialog
        ref={ref}
        aria-label={`Details: ${name}`}
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        className="details m-auto h-[100dvh] max-h-none w-full max-w-none bg-transparent p-0 text-ink backdrop:bg-black/60 backdrop:backdrop-blur-sm sm:h-[88vh] sm:w-[calc(100%-3rem)] sm:max-w-6xl"
      >
        <div className="flex h-full flex-col overflow-hidden bg-card sm:rounded-2xl sm:border sm:border-edge">
          <header className="flex items-center gap-3 border-b border-edge px-4 py-3 sm:px-5">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{name}</span>
              <span className="block truncate text-xs text-mute">{domain}</span>
            </span>
            <a href={url} target="_blank" rel="noopener noreferrer" className="group btn-sheen inline-flex h-9 items-center gap-1.5 rounded-lg bg-fill px-3 text-sm font-semibold text-on-fill">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Visit site
            </a>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* The whole page, scrollable */}
            <div className="min-h-0 overflow-y-auto border-edge bg-raised max-lg:h-[42vh] lg:border-r" tabIndex={0} aria-label="Full-page screenshot, scrollable">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={full ? `${shot}/full.jpg` : `${shot}/hero.jpg`}
                alt={`Full page of ${domain}`}
                onError={() => setFull(false)}
                className="block w-full"
              />
            </div>

            {/* The scorecard */}
            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
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
              ) : (
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
          </div>
        </div>
      </dialog>
    </>
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
