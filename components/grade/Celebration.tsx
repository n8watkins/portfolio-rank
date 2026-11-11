"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crown, Medal, PartyPopper, Sparkles, Trophy, X } from "lucide-react";
import { BadgeArt } from "@/components/ui/BadgeArt";

type Level = { level: number; title: string; line: string; badge?: string };
type Badge = { id: string; name: string; hue: number; new: boolean };

const SEEN_KEY = "pr_celebrated";
const SHOW_MS = 9000;
const ICON = [Sparkles, Sparkles, PartyPopper, Medal, Trophy, Crown];
// The banner's icon tile, escalating with the level: amber, amber, violet, rose, gold.
const TILE = [
  "",
  "bg-accent-soft text-accent",
  "bg-accent-soft text-accent",
  "bg-[hsl(265_80%_60%/0.14)] text-[hsl(265_70%_58%)]",
  "bg-[hsl(345_85%_60%/0.14)] text-[hsl(345_75%_55%)]",
  "bg-[linear-gradient(135deg,#fde68a,#f59e0b)] text-[#5b3a00]",
];

function seen(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function markSeen(id: string) {
  try {
    const ids = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]).filter((x) => x !== id);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids, id].slice(-50)));
  } catch {}
}

/**
 * The report's celebration for its owner, once per report in this browser:
 * the effect for the level (components/grade/celebration-fx.ts, loaded only
 * here and never under reduced motion) and a banner that says what the
 * result means. With the games on, a Top 25% or better grade also earns its
 * badge, which the banner announces (the in-app notification; the badge
 * then stays on /me).
 */
export function Celebration({ id, level, anchor, games }: { id: string; level: Level | null; anchor: string; games: boolean }) {
  const [open, setOpen] = useState(false);
  const [badge, setBadge] = useState<Badge | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!level || started.current || seen(id)) return;
    started.current = true;
    markSeen(id);
    let stop: (() => void) | undefined;
    let live = true;
    // Let the report's own entrance land first.
    const t = setTimeout(() => {
      setOpen(true);
      // Read now, not from a hook: on the first render a hook still has the server's answer.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const el = document.getElementById(anchor);
      const r = el?.getBoundingClientRect();
      const origin = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
      import("./celebration-fx").then((fx) => {
        if (live) stop = fx.celebrate(level.level, origin);
      });
    }, 450);
    if (games && level.badge) {
      fetch("/api/badges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "report", id }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { badges?: string[] } | null) => (d?.badges?.length ? fetch("/api/badges", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)) : null))
        .then((d: { badges?: Badge[] } | null) => {
          // Listing marks the badge told, so no other page announces it again.
          const b = d?.badges?.find((x) => x.id === level.badge && x.new);
          if (live && b) setBadge(b);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
      clearTimeout(t);
      stop?.();
    };
  }, [id, level, anchor, games]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), badge ? SHOW_MS + 3000 : SHOW_MS);
    return () => clearTimeout(t);
  }, [open, badge]);

  if (!level || !open) return null;
  const Icon = ICON[level.level];
  // On <body>, so an animated (transformed) ancestor never holds the fixed banner in its own box.
  return createPortal(
    <div
      role="status"
      className="pop-in fixed top-[4.75rem] right-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-edge bg-card p-3 shadow-2xl shadow-black/25 print:hidden"
    >
      <div className="flex items-center gap-3">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${TILE[level.level]}`}>
          <Icon className="h-6 w-6" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold leading-tight">{level.title}!</span>
          <span className="mt-0.5 block text-sm leading-snug text-mute">{level.line}</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Dismiss"
          className="grid h-10 w-10 shrink-0 place-items-center self-start rounded-lg text-mute hover:bg-raised hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {badge && (
        <div className="pop-in mt-3 flex items-center gap-3 rounded-xl bg-raised p-2.5" style={{ animationDelay: "250ms" }}>
          <BadgeArt id={badge.id} hue={badge.hue} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-accent">Badge earned</span>
            <span className="block text-sm font-semibold">{badge.name}</span>
          </span>
          <a href="/me#badges" className="shrink-0 rounded-lg px-2.5 py-2 text-sm font-semibold text-accent hover:bg-card">
            See badges
          </a>
        </div>
      )}
    </div>,
    document.body
  );
}
