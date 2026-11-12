import type React from "react";
import { ArrowDown, ArrowUp, Minus, Trophy } from "lucide-react";
import { medalFor } from "@/lib/ranking/places.mjs";
import { BELOW_TOP_TIERS, isPublicTier } from "@/lib/tiers.mjs";

// Small marks shared by the leaderboard, reports, cards and Play.

export const TIER_STYLE: Record<string, string> = {
  // The top 3 and the top 10 (lib/tiers.mjs): gold, framed by a thin ring (TIER_FRAME), so they read above a plain S.
  SSS: "text-[#2a1d06]",
  SS: "bg-fill text-on-fill",
  S: "bg-fill text-on-fill",
  A: "bg-accent-soft text-accent ring-1 ring-inset ring-accent/25",
  B: "bg-raised text-ink ring-1 ring-inset ring-edge-strong",
  C: "bg-raised text-ink ring-1 ring-inset ring-edge",
  D: "bg-raised text-mute ring-1 ring-inset ring-edge",
};

/** SS gets a gold ring around the amber tile; SSS a metallic gold tile (the gold medal's) with the ring and a soft glow. */
const TIER_FRAME: Record<string, React.CSSProperties> = {
  SSS: {
    background: "linear-gradient(145deg, #fde68a, #e9b949 55%, #b7861c)",
    boxShadow: "0 0 0 2px var(--color-card), 0 0 0 3.5px #e9b949, 0 6px 16px -6px rgba(233, 185, 73, 0.75)",
  },
  SS: { boxShadow: "0 0 0 2px var(--color-card), 0 0 0 3.5px var(--color-fill)" },
};

/** Letter sizes that keep SS and SSS inside the square. */
const TIER_TEXT = {
  md: { 1: "text-sm", 2: "text-[13px] tracking-tight", 3: "text-[11px] tracking-tighter" },
  lg: { 1: "text-3xl", 2: "text-[26px] tracking-tight", 3: "text-xl tracking-tight" },
} as const;

/** A grade tier (SSS to D, by rank: lib/tiers.mjs) as a square badge. */
export function TierBadge({ tier, size = "md" }: { tier: string; size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-16 w-16 rounded-2xl" : "h-8 w-8 rounded-lg";
  const text = TIER_TEXT[size][Math.min(3, Math.max(1, tier.length)) as 1 | 2 | 3];
  return (
    <span
      role="img"
      aria-label={`Tier ${tier}`}
      className={`grid shrink-0 place-items-center font-bold leading-none ${box} ${text} ${TIER_STYLE[tier] ?? TIER_STYLE.C}`}
      style={TIER_FRAME[tier]}
    >
      <span aria-hidden>{tier}</span>
    </span>
  );
}

/**
 * Another portfolio's tier where the public can see it: the letter for the
 * top tiers (SSS to B, lib/tiers.mjs PUBLIC_TIERS), else a blank square the
 * same size that says "Graded, below the top tiers" to screen readers, so
 * no one gets a public C or D.
 */
export function PublicTierBadge({ tier }: { tier: string | null | undefined }) {
  if (tier && isPublicTier(tier)) return <TierBadge tier={tier} />;
  return (
    <span role="img" aria-label={tier ? BELOW_TOP_TIERS : "Not graded yet"} title={tier ? BELOW_TOP_TIERS : undefined} className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-inset ring-edge" />
  );
}

const MEDAL: Record<string, { name: string; ring: string; fill: string }> = {
  gold: { name: "Gold", ring: "#e9b949", fill: "linear-gradient(145deg, #fde68a, #e9b949 55%, #b7861c)" },
  silver: { name: "Silver", ring: "#b9bec8", fill: "linear-gradient(145deg, #f4f5f7, #c3c8d1 55%, #8d94a1)" },
  bronze: { name: "Bronze", ring: "#c48a5c", fill: "linear-gradient(145deg, #f3c9a4, #c48a5c 55%, #8f5a33)" },
};

/**
 * The first three places get a gold, silver or bronze medal, one each; the
 * rest a plain number ("=4" when tied). `place` is the row's position in the
 * board's order (lib/ranking/places.mjs) and defaults to `rank` where ranks
 * are never shared; `rank` is the number shown, which tied rows share.
 */
export function RankBadge({ rank, place = rank, tied, size = "md" }: { rank: number; place?: number; tied?: boolean; size?: "md" | "lg" }) {
  const medal = medalFor(place);
  const m = medal ? MEDAL[medal] : null;
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
