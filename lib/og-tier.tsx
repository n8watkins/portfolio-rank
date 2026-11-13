import type { CSSProperties } from "react";
import { familyOf, modifierOf } from "@/lib/tiers.mjs";

// The tier chip on the share cards (lib/og-portfolio.tsx, lib/play/share-card.tsx),
// drawn by Satori: one look everywhere a card shows a tier. The S family is
// the flat amber tile; S+ adds a gold ring around it; SSS is metallic gold
// (the leaderboard's gold medal) with the ring and a warm glow, so the top 3
// and the top 10 read above a plain S without turning into a sticker.

const BG = "#0a0a0b";
const AMBER = "#fbbf24";
const GOLD = "#e9b949";

const LOOK: Record<string, { background: string; color: string; border: string; ring?: string; glow?: string }> = {
  SSS: { background: `linear-gradient(145deg, #fde68a, ${GOLD} 55%, #b7861c)`, color: "#2a1d06", border: BG, ring: GOLD, glow: "rgba(233,185,73,0.45)" },
  "S+": { background: AMBER, color: BG, border: BG, ring: AMBER },
  S: { background: AMBER, color: BG, border: BG },
  A: { background: "#3a2a0a", color: AMBER, border: AMBER },
  B: { background: "#1c1c21", color: "#ededf0", border: AMBER },
  C: { background: "#1c1c21", color: "#ededf0", border: AMBER },
  D: { background: "#1c1c21", color: "#a1a1aa", border: AMBER },
};

/**
 * The tier chip at `box` pixels square: the letter with a typeset plus or
 * minus beside it, a little smaller and centred on the letter (the badge's
 * design, components/ui/badges.tsx). `style` places it (position, left, bottom).
 */
export function TierChip({ tier, box = 132, style = {} }: { tier: string; box?: number; style?: CSSProperties }) {
  const family = familyOf(tier) ?? "C";
  const mod = modifierOf(tier);
  const look = LOOK[tier] ?? LOOK[family] ?? LOOK.C;
  const sss = tier === "SSS";
  const size = Math.round(box * (sss ? 0.4 : 0.58));
  const shadows = [look.ring ? `0 0 0 5px ${look.ring}` : null, look.glow ? `0 0 46px ${look.glow}` : null, "0 18px 40px rgba(0,0,0,0.5)"].filter(Boolean);
  return (
    <div
      style={{
        display: "flex",
        width: box,
        height: box,
        borderRadius: Math.round(box * 0.23),
        alignItems: "center",
        justifyContent: "center",
        fontSize: size,
        fontWeight: 800,
        letterSpacing: sss ? -0.04 * size : 0,
        background: look.background,
        color: look.color,
        border: `3px solid ${look.border}`,
        boxShadow: shadows.join(", "),
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex" }}>{sss ? "SSS" : family}</div>
        {mod && <div style={{ display: "flex", fontSize: Math.round(size * 0.8), marginLeft: Math.round(size * 0.03), marginTop: -Math.round(size * 0.06) }}>{mod === "+" ? "+" : "\u2212"}</div>}
      </div>
    </div>
  );
}
