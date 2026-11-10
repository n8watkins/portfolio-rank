import { Crown } from "lucide-react";

/** One labelled result row: label, count, percent, and a bar that says the same. */
export function PollBar({ label, votes, pct, lead, mine = false }: { label: string; votes: number; pct: number; lead: boolean; mine?: boolean }) {
  return (
    <div className={lead ? "rounded-lg" : ""}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{label}</span>
          {lead && <Crown className="pop-in h-3.5 w-3.5 shrink-0 text-accent" style={{ animationDelay: "650ms" }} aria-label="Leading" />}
          {mine && <span className="shrink-0 rounded-full border border-edge-strong px-1.5 text-[10px] font-semibold uppercase tracking-wide text-mute">Your vote</span>}
        </span>
        <span className="shrink-0 tabular-nums">
          <strong>{pct}%</strong> <span className="text-mute">· {votes.toLocaleString()} votes</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div className={`bar-fill h-full rounded-full ${lead ? "bg-fill" : "bg-edge-strong"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
