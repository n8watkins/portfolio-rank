import { Award } from "lucide-react";
import { BadgeArt } from "@/components/preview/BadgeArt";
import { SampleTag } from "@/components/preview/bits";
import { badgeStatus, sampleCounters } from "@/lib/preview/badges";

/** Earned badges first, then locked ones with progress. */
export function Badges({ state, signedIn }: { state: string; signedIn: boolean }) {
  const all = badgeStatus(sampleCounters(state));
  const earned = all.filter((b) => b.earned);
  const locked = all.filter((b) => !b.earned);
  return (
    <section aria-labelledby="badges" className="card reveal mt-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="badges" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Award className="h-4 w-4 text-mute" aria-hidden /> Badges
          <span className="text-sm font-normal text-mute tabular-nums">
            {earned.length} of {all.length}
          </span>
        </h2>
        <span className="flex items-center gap-2 text-xs text-mute">
          {!signedIn && <span>Saved in this browser. Sign in to keep your badges.</span>}
          <SampleTag what="Badge progress" />
        </span>
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[...earned, ...locked].map((b) => (
          <li key={b.id} className={`flex items-center gap-3 rounded-xl border p-3 ${b.earned ? "border-edge bg-bg/40" : "border-dashed border-edge"}`}>
            <BadgeArt id={b.id} hue={b.hue} locked={!b.earned} size={44} />
            <span className="min-w-0">
              <span className={`block truncate text-sm font-semibold ${b.earned ? "" : "text-mute"}`}>{b.name}</span>
              <span className="block text-xs text-mute">{b.how}</span>
              {!b.earned && b.target > 1 && (
                <span className="mt-1 block text-[11px] tabular-nums text-mute">
                  {b.have.toLocaleString()} / {b.target.toLocaleString()}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
