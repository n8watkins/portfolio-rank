"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { PsiResult } from "@/app/api/psi/route";
import type { SiteDetails } from "@/lib/play/details";

// Play's details for each site, held once in the browser for the whole visit
// (module state survives moving between pages), so a card never asks on its
// own and going back to Play asks for nothing.
// - The face-off seeds it from each pair (/api/rank carries every card's
//   details); Guess and anything else ask /api/play/details once per site.
// - A Lighthouse result that is missing is measured once (/api/psi, whose
//   per-site lease shares the run); one still running is re-read with one
//   slow poll for the visible sites only (every POLL_MS, at most POLLS times).
// - A missing polish check is filled once (/api/inspect).

type Strategy = "mobile" | "desktop";

// The site's links load whole pages, so the store is also kept in
// sessionStorage (the latest KEEP sites, for KEEP_MS): back to Play, or a
// reload, fills the cards without asking again. A measurement cut off by
// leaving is not kept as running; the card measures again (the lease shares it).
const KEY = "pr-play-details";
const KEEP = 24;
const KEEP_MS = 30 * 60 * 1000;
type Kept = { at: number; d: SiteDetails };
const store = new Map<string, SiteDetails>();
const keptAt = new Map<string, number>();
const notRunning = (r: PsiResult | null) => (r && r.ok === false && (r.error === "in_progress" || r.error === "still_measuring") ? null : r);
function restore() {
  if (typeof window === "undefined") return;
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, Kept>;
    for (const [url, k] of Object.entries(v)) {
      if (!k?.d || !Number.isFinite(k.at) || Date.now() - k.at > KEEP_MS) continue;
      store.set(url, k.d);
      keptAt.set(url, k.at);
    }
  } catch {
    /* storage off: the store lives for this page only */
  }
}
function persist() {
  try {
    const latest = [...store.keys()].sort((a, b) => (keptAt.get(b) ?? 0) - (keptAt.get(a) ?? 0)).slice(0, KEEP);
    const out: Record<string, Kept> = {};
    for (const url of latest) {
      const d = store.get(url)!;
      out[url] = { at: keptAt.get(url) ?? Date.now(), d: { ...d, psi: { mobile: notRunning(d.psi.mobile), desktop: notRunning(d.psi.desktop) } } };
    }
    sessionStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* storage off or full: nothing breaks */
  }
}
restore();

const listeners = new Set<() => void>();
let saving: ReturnType<typeof setTimeout> | null = null;
const notify = () => {
  listeners.forEach((l) => l());
  if (!saving) saving = setTimeout(() => ((saving = null), persist()), 500);
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Puts details from a pair or a details answer into the store. A site it
 * already holds keeps what it has (as new or newer: a measurement may have
 * landed since that pair was drawn).
 */
export function seedDetails(map: Record<string, SiteDetails | null | undefined> | null | undefined) {
  if (!map) return;
  let changed = false;
  for (const [url, d] of Object.entries(map)) {
    if (!d || store.has(url)) continue;
    store.set(url, d);
    keptAt.set(url, Date.now());
    changed = true;
  }
  if (changed) notify();
}

function patch(url: string, f: (d: SiteDetails) => SiteDetails) {
  const d = store.get(url);
  if (!d) return;
  store.set(url, f(d));
  notify();
}

const asked = new Set<string>();
/** One /api/play/details request for sites the store doesn't have (Guess, a deep link). */
function askFor(url: string) {
  if (store.has(url) || asked.has(url)) return;
  asked.add(url);
  fetch(`/api/play/details?url=${encodeURIComponent(url)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => seedDetails(d?.details))
    .catch(() => asked.delete(url));
}

const running = (r: PsiResult | null | undefined) => r?.ok === false && (r.error === "in_progress" || r.error === "still_measuring");

// One measurement per site and strategy for the visit (a Retry asks again).
const measured = new Set<string>();
function measure(url: string, strategy: Strategy, force = false) {
  const k = `${strategy}:${url}`;
  if (measured.has(k) && !force) return;
  measured.add(k);
  patch(url, (d) => ({ ...d, psi: { ...d.psi, [strategy]: { ok: false, error: "in_progress" } } }));
  fetch(`/api/psi?url=${encodeURIComponent(url)}${strategy === "desktop" ? "&strategy=desktop" : ""}`)
    .then((r) => r.json() as Promise<PsiResult>)
    .then((res) => patch(url, (d) => ({ ...d, psi: { ...d.psi, [strategy]: res } })))
    .catch(() => patch(url, (d) => ({ ...d, psi: { ...d.psi, [strategy]: { ok: false, error: "fetch_error" } } })))
    .finally(() => schedulePoll());
}

const inspected = new Set<string>();
function fillInspect(url: string) {
  if (inspected.has(url)) return;
  inspected.add(url);
  fetch(`/api/inspect?url=${encodeURIComponent(url)}`)
    .then((r) => r.json())
    .then((res) => patch(url, (d) => ({ ...d, inspect: res })))
    .catch(() => {});
}

// The slow poll: only for the sites on screen, only while one of their
// measurements is still running somewhere, one request for all of them.
const POLL_MS = 6_000;
const POLLS = 20;
let visible: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let polls = 0;
function pending() {
  return visible.filter((u) => {
    const d = store.get(u);
    return d && (running(d.psi.mobile) || running(d.psi.desktop));
  });
}
function schedulePoll() {
  if (timer || polls >= POLLS) return;
  if (!pending().length) return;
  timer = setTimeout(async () => {
    timer = null;
    const urls = pending();
    if (!urls.length) return;
    polls++;
    try {
      const r = await fetch(`/api/play/details?${urls.map((u) => `url=${encodeURIComponent(u)}`).join("&")}`, { cache: "no-store" });
      const d = r.ok ? await r.json() : null;
      // Keep a local "measuring" until the stored result lands (a miss reads as null).
      for (const [url, sd] of Object.entries((d?.details ?? {}) as Record<string, SiteDetails>)) {
        const cur = store.get(url);
        if (!cur) continue;
        store.set(url, {
          ...sd,
          psi: {
            mobile: sd.psi.mobile ?? cur.psi.mobile,
            desktop: sd.psi.desktop ?? cur.psi.desktop,
          },
        });
      }
      notify();
    } catch {
      /* the next poll tries again */
    }
    schedulePoll();
  }, POLL_MS);
}

/** The sites on screen now: only they are polled. */
export function setVisible(urls: string[]) {
  visible = urls;
  polls = 0;
  schedulePoll();
}

/**
 * A site's details for a card, filling what is missing: asks for the site
 * when the store doesn't have it, measures a missing Lighthouse result once,
 * fills a missing polish check once. Undefined while nothing is known yet.
 */
export function useSiteDetails(url: string): SiteDetails | undefined {
  const d = useSyncExternalStore(subscribe, () => store.get(url), () => undefined);
  useEffect(() => {
    if (!d) return askFor(url);
    if (!d.inspect) fillInspect(url);
    for (const s of ["mobile", "desktop"] as const) {
      const r = d.psi[s];
      if (!r || (r.ok === false && r.error === "not_measured")) measure(url, s);
      else if (running(r)) schedulePoll();
    }
  }, [url, d]);
  return d;
}

/** Retry after a failed measurement (asks PageSpeed again for that site and strategy). */
export function retryMeasure(url: string, strategy: Strategy) {
  measure(url, strategy, true);
}
