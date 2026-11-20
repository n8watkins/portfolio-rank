"use client";

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

// What Play shows about each portfolio, chosen by the viewer and remembered
// in this browser (localStorage; every read and write survives storage being
// off). "simple" and "detailed" are presets; ticking a box makes the view
// "custom".

export const METRICS = [
  { id: "performance", label: "Performance" },
  { id: "accessibility", label: "Accessibility" },
  { id: "best-practices", label: "Best practices" },
  { id: "seo", label: "SEO" },
] as const;
export const SECTIONS = [
  { id: "preview", label: "Link preview" },
  { id: "polish", label: "Polish checklist" },
  { id: "built", label: "Built with" },
] as const;

export type MetricId = (typeof METRICS)[number]["id"];
export type SectionId = (typeof SECTIONS)[number]["id"];
export type ViewPrefs = { mode: "simple" | "detailed" | "custom"; metrics: MetricId[]; sections: SectionId[] };

export const SIMPLE: ViewPrefs = { mode: "simple", metrics: ["performance"], sections: [] };
export const DETAILED: ViewPrefs = { mode: "detailed", metrics: METRICS.map((m) => m.id), sections: SECTIONS.map((s) => s.id) };

const KEY = "pr-play-view";

function read(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return SIMPLE;
    const metrics = (Array.isArray(v.metrics) ? v.metrics : []).filter((m: unknown) => METRICS.some((x) => x.id === m));
    const sections = (Array.isArray(v.sections) ? v.sections : []).filter((s: unknown) => SECTIONS.some((x) => x.id === s));
    const mode = v.mode === "simple" || v.mode === "detailed" || v.mode === "custom" ? v.mode : "custom";
    return { mode, metrics, sections };
  } catch {
    return SIMPLE;
  }
}

function write(p: ViewPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage off: the choice lasts for this page only */
  }
}

/**
 * Applies a view change through a View Transition where the browser has one
 * and motion is welcome: the old and new layouts cross-fade and each card
 * eases to its new height (app/globals.css). Otherwise the change is instant.
 */
export function animated(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || still) return update();
  doc.startViewTransition(() => flushSync(update));
}

/** The viewer's Play view: Simple (the two sites first, details folded away) until they choose. */
export function useViewPrefs() {
  const [prefs, setPrefs] = useState<ViewPrefs>(SIMPLE);
  useEffect(() => {
    // Read once after hydration (localStorage is not on the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(read());
  }, []);
  const choose = useCallback((p: ViewPrefs) => {
    animated(() => setPrefs(p));
    write(p);
  }, []);
  const toggle = useCallback((kind: "metrics" | "sections", id: string) => {
    animated(() =>
      setPrefs((p) => {
        const list = p[kind] as string[];
        const next = { ...p, mode: "custom" as const, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] } as ViewPrefs;
        write(next);
        return next;
      }),
    );
  }, []);
  return { prefs, choose, toggle };
}
