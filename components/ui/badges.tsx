import type React from "react";
import { ArrowDown, ArrowUp, Minus, Trophy } from "lucide-react";
import { medalFor } from "@/lib/ranking/places.mjs";
import { BELOW_TOP_TIERS, familyOf, isPublicTier, modifierOf, tierLabel } from "@/lib/tiers.mjs";

// Small marks shared by the leaderboard, reports, cards and Play.

/** The tile of each letter family (lib/tiers.mjs familyOf); SSS and S+ add a frame (TIER_FRAME). */
export const TIER_STYLE: Record<string, string> = {
  SSS: "text-[#2a1d06]",
  S: "bg-fill text-on-fill",
  // The top 30% (owner, 2026-11-12: many more people should be proud to share an A): a strong gold ring and a soft glow.
  A: "bg-accent-soft text-accent ring-2 ring-inset ring-accent/80 shadow-[0_4px_14px_-6px_var(--color-accent)]",
  B: "bg-raised text-ink ring-1 ring-inset ring-edge-strong",
  C: "bg-raised text-ink ring-1 ring-inset ring-edge",
  D: "bg-raised text-mute ring-1 ring-inset ring-edge",
};

/** S+ gets a gold ring around the amber tile; SSS a metallic gold tile (the gold medal's) with the ring and a soft glow. */
const TIER_FRAME: Record<string, React.CSSProperties> = {
  SSS: {
    background: "linear-gradient(145deg, #fde68a, #e9b949 55%, #b7861c)",
    boxShadow: "0 0 0 2px var(--color-card), 0 0 0 3.5px #e9b949, 0 6px 16px -6px rgba(233, 185, 73, 0.75)",
  },
  "S+": { boxShadow: "0 0 0 2px var(--color-card), 0 0 0 3.5px var(--color-fill)" },
};

const SIZE = {
  md: { box: "h-8 w-8 rounded-lg", letter: "text-sm", sss: "text-[11px] tracking-tighter" },
  lg: { box: "h-16 w-16 rounded-2xl", letter: "text-3xl", sss: "text-xl tracking-tight" },
} as const;

const MOD_NAME: Record<string, string> = { "+": "plus", "-": "minus" };

/**
 * A grade tier (SSS, S+ ... D, by rank: lib/tiers.mjs) as a square badge: the
 * letter with a typeset plus or minus right beside it, in the same face and
 * weight, a little smaller and centred on the letter ("S−", "A+"). The minus
 * is a real minus sign, as wide as the plus.
 */
export function TierBadge({ tier, size = "md" }: { tier: string; size?: "md" | "lg" }) {
  const z = SIZE[size];
  const family = familyOf(tier) ?? "C";
  const mod = modifierOf(tier);
  const look = tier === "SSS" ? TIER_STYLE.SSS : (TIER_STYLE[family] ?? TIER_STYLE.C);
  return (
    <span
      role="img"
      aria-label={`Tier ${tier === "SSS" ? "SSS" : family}${mod ? ` ${MOD_NAME[mod]}` : ""}`}
      title={`Tier ${tierLabel(tier)}`}
      className={`grid shrink-0 place-items-center font-bold leading-none ${z.box} ${look}`}
      style={TIER_FRAME[tier]}
    >
      {tier === "SSS" ? (
        <span aria-hidden className={z.sss}>
          SSS
        </span>
      ) : (
        <span aria-hidden className={`inline-flex items-center ${z.letter}`}>
          {family}
          {mod && <span className="-translate-y-[0.06em] pl-[0.03em] text-[0.8em]">{mod === "+" ? "+" : "\u2212"}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * Another portfolio's tier where the public can see it: the letter for the
 * top tiers (SSS to B-, lib/tiers.mjs PUBLIC_TIERS), else a blank square the
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
