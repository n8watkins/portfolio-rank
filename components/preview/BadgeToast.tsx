"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { BadgeArt } from "@/components/preview/BadgeArt";
import type { BadgeIcon } from "@/lib/preview/badges";

/** "Badge earned" toast, bottom right (above the phone tab bar). */
export function BadgeToast({ id, hue, name, how, guest }: { id: BadgeIcon; hue: number; name: string; how: string; guest: boolean }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOpen(false), 8000);
    return () => clearTimeout(t);
  }, []);
  if (!open) return null;
  return (
    <div
      role="status"
      className="pop-in fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-edge bg-card p-3 pr-2 shadow-2xl shadow-black/30 lg:bottom-6"
    >
      <BadgeArt id={id} hue={hue} size={48} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wider text-accent">Badge earned</span>
        <span className="block font-semibold">{name}</span>
        <span className="block text-xs text-mute">{guest ? "Sign in to keep your badges." : how}</span>
      </span>
      <button type="button" onClick={() => setOpen(false)} aria-label="Dismiss" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
