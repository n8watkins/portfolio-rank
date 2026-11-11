import { ArrowDown, ArrowUp, Minus, Trophy } from "lucide-react";

// Small marks shared by the leaderboard, reports, cards and Play.

export const TIER_STYLE: Record<string, string> = {
  S: "bg-fill text-on-fill",
  A: "bg-accent-soft text-accent ring-1 ring-inset ring-accent/25",
  B: "bg-raised text-ink ring-1 ring-inset ring-edge-strong",
  C: "bg-raised text-ink ring-1 ring-inset ring-edge",
  D: "bg-raised text-mute ring-1 ring-inset ring-edge",
};

/** A grade tier (S to D) as a square badge. */
export function TierBadge({ tier, size = "md" }: { tier: string; size?: "md" | "lg" }) {
  const s = size === "lg" ? "h-16 w-16 rounded-2xl text-3xl" : "h-8 w-8 rounded-lg text-sm";
  return (
    <span role="img" aria-label={`Tier ${tier}`} className={`grid shrink-0 place-items-center font-bold ${s} ${TIER_STYLE[tier] ?? TIER_STYLE.C}`}>
      <span aria-hidden>{tier}</span>
    </span>
  );
}

const MEDAL: Record<number, { name: string; ring: string; fill: string }> = {
  1: { name: "Gold", ring: "#e9b949", fill: "linear-gradient(145deg, #fde68a, #e9b949 55%, #b7861c)" },
  2: { name: "Silver", ring: "#b9bec8", fill: "linear-gradient(145deg, #f4f5f7, #c3c8d1 55%, #8d94a1)" },
  3: { name: "Bronze", ring: "#c48a5c", fill: "linear-gradient(145deg, #f3c9a4, #c48a5c 55%, #8f5a33)" },
};

/** Ranks 1-3 get a gold, silver or bronze medal; the rest a plain number ("=4" when tied). */
export function RankBadge({ rank, tied, size = "md" }: { rank: number; tied?: boolean; size?: "md" | "lg" }) {
  const m = MEDAL[rank];
  if (!m) return <span className="text-sm font-bold tabular-nums text-mute">{tied ? `=${rank}` : rank}</span>;
  const s = size === "lg" ? "h-10 w-10" : "h-8 w-8";
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-full ${s}`}
      style={{ background: m.fill, boxShadow: `0 0 0 2px var(--color-card), 0 0 0 3.5px ${m.ring}, 0 6px 14px -4px ${m.ring}` }}
      role="img"
      aria-label={`${m.name} trophy, rank ${tied ? "=" : ""}${rank}`}
      title={`#${rank}`}
    >
      <Trophy className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} style={{ color: "#2a1d06" }} strokeWidth={2.2} aria-hidden />
    </span>
  );
}

/** Rank movement: green up, red down, a dash for no change. */
export function Movement({ move, period = "this week", className = "" }: { move: number; period?: string; className?: string }) {
  if (move === 0)
    return (
      <span role="img" className={`inline-flex items-center text-mute ${className}`} aria-label={`No change ${period}`}>
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  const up = move > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      role="img"
      className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${up ? "text-up" : "text-down"} ${className}`}
      aria-label={`${up ? "Up" : "Down"} ${Math.abs(move)} ${period}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span aria-hidden>{Math.abs(move)}</span>
    </span>
  );
}
