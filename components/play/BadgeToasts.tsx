"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { BadgeArt } from "@/components/play/BadgeArt";

type Badge = { id: string; name: string; how: string; hue: number; new: boolean };

// A "Badge earned" toast is told once (owner): GET /api/badges marks every
// badge it lists as `new` told, so whatever page asks first shows it and no
// page shows it again. Badges are checked after something that can earn one
// (a vote, a finished quiz, a share, a save), at most every CHECK_MS, since
// each check reads the player's history (lib/games/badges.mjs).
const CHECK_MS = 20_000;
const SHOW_MS = 8_000;

/**
 * Returns `check()`, to call after something that may have earned a badge
 * (`now` skips the wait: the server just said a badge was earned), and the
 * toast element to render. Off (no requests) unless `enabled` (GAMES_V2).
 */
export function useBadgeToasts(enabled: boolean, guest: boolean) {
  const [queue, setQueue] = useState<Badge[]>([]);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = useCallback(async () => {
    last.current = Date.now();
    try {
      const res = await fetch("/api/badges", { cache: "no-store" });
      if (!res.ok) return;
      const data: { badges?: Badge[] } = await res.json();
      const fresh = (data.badges ?? []).filter((b) => b.new);
      if (fresh.length) setQueue((q) => [...q, ...fresh.filter((b) => !q.some((x) => x.id === b.id))]);
    } catch {
      /* a missed toast is not worth an error */
    }
  }, []);

  const check = useCallback(
    (now = false) => {
      if (!enabled) return;
      clearTimeout(timer.current);
      const wait = now ? 0 : Math.max(0, last.current + CHECK_MS - Date.now());
      timer.current = setTimeout(run, wait);
    },
    [enabled, run]
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  const toast = queue[0] ? <BadgeToast key={queue[0].id} badge={queue[0]} guest={guest} onDone={() => setQueue((q) => q.slice(1))} /> : null;
  return { check, toast };
}

/**
 * "Badge earned" for 8 seconds, top right under the header: at the bottom
 * (the preview's place) it covered Next pair on phones and the end card's
 * buttons on short screens.
 */
function BadgeToast({ badge, guest, onDone }: { badge: Badge; guest: boolean; onDone: () => void }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const t = setTimeout(() => done.current(), SHOW_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="status"
      className="pop-in fixed top-[4.75rem] right-4 z-30 flex w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-edge bg-card p-3 pr-2 shadow-2xl shadow-black/30 lg:bottom-6"
    >
      <BadgeArt id={badge.id} hue={badge.hue} size={48} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold tracking-wider text-accent uppercase">Badge earned</span>
        <span className="block font-semibold">{badge.name}</span>
        <span className="block text-xs text-mute">{guest ? "Sign in to keep your badges." : badge.how}</span>
      </span>
      <button type="button" onClick={onDone} aria-label="Dismiss" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
