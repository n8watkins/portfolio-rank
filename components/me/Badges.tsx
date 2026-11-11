"use client";

import { useEffect, useState } from "react";
import { Award } from "lucide-react";
import { BadgeArt } from "@/components/ui/BadgeArt";

export type BadgeDef = { id: string; name: string; how: string; hue: number; target: number };
type Status = BadgeDef & { progress: number; earned: boolean; new: boolean };

/**
 * Badges (GAMES_V2): every badge, earned first, then the locked ones with
 * their progress. The list renders at once (all locked) and fills from
 * /api/badges, so nothing moves; a badge earned since the last look says New.
 */
export function Badges({ defs }: { defs: BadgeDef[] }) {
  const [list, setList] = useState<Status[]>(() => defs.map((b) => ({ ...b, progress: 0, earned: false, new: false })));
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/badges", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { badges: Status[]; signedIn: boolean } | null) => {
        if (!alive || !b) return;
        setList(b.badges);
        setSignedIn(b.signedIn);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [all, setAll] = useState(false);
  const earned = list.filter((b) => b.earned);
  // Locked ones closest to done first: on a phone only the next three show until asked.
  const locked = list.filter((b) => !b.earned).sort((a, b) => b.progress / b.target - a.progress / a.target);
  const NEXT = 3;

  return (
    <section aria-labelledby="badges" className="card reveal mt-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="badges" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Award className="h-4 w-4 text-mute" aria-hidden /> Badges
          <span className="text-sm font-normal text-mute tabular-nums">
            {earned.length} of {list.length}
          </span>
        </h2>
        {signedIn === false && <span className="text-xs text-mute">Saved in this browser. Sign in to keep your badges.</span>}
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[...earned, ...locked].map((b, k) => (
          <li
            key={b.id}
            className={`flex items-center gap-3 rounded-xl border p-3 ${b.earned ? "border-edge bg-bg/40" : "border-dashed border-edge"} ${
              !all && k >= earned.length + NEXT ? "max-sm:hidden" : ""
            }`}
          >
            <BadgeArt id={b.id} hue={b.hue} locked={!b.earned} size={44} />
            <span className="min-w-0">
              <span className={`flex items-center gap-1.5 text-sm font-semibold ${b.earned ? "" : "text-mute"}`}>
                <span className="min-w-0">{b.name}</span>
                {b.new && <span className="pop-in shrink-0 rounded-full bg-fill px-1.5 text-[10px] font-bold uppercase text-on-fill">New</span>}
              </span>
              <span className="block text-xs text-mute">{b.how}</span>
              {!b.earned && b.target > 1 && (
                <span className="mt-1 block text-[11px] tabular-nums text-mute">
                  {b.progress.toLocaleString("en-US")} / {b.target.toLocaleString("en-US")}
                </span>
              )}
              <span className="sr-only">{b.earned ? "Earned." : "Not earned yet."}</span>
            </span>
          </li>
        ))}
      </ul>
      {!all && locked.length > NEXT && (
        <button type="button" onClick={() => setAll(true)} className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-edge text-sm font-semibold sm:hidden">
          Show all {list.length} badges
        </button>
      )}
    </section>
  );
}
