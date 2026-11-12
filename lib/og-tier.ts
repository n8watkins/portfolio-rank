import type { CSSProperties } from "react";

// The tier chip on the share cards (lib/og-portfolio.tsx, lib/play/share-card.tsx),
// drawn by Satori: one look everywhere a card shows a tier. S is the flat
// amber tile; SS adds a gold ring around it; SSS is metallic gold (the
// leaderboard's gold medal) with the ring and a warm glow, so the top 2% and
// 5% read above a plain S without turning into a sticker.

const BG = "#0a0a0b";
const AMBER = "#fbbf24";
const GOLD = "#e9b949";

const LOOK: Record<string, { background: string; color: string; border: string; ring?: string; glow?: string }> = {
  SSS: { background: `linear-gradient(145deg, #fde68a, ${GOLD} 55%, #b7861c)`, color: "#2a1d06", border: BG, ring: GOLD, glow: "rgba(233,185,73,0.45)" },
  SS: { background: AMBER, color: BG, border: BG, ring: AMBER },
  S: { background: AMBER, color: BG, border: BG },
  A: { background: "#3a2a0a", color: AMBER, border: AMBER },
  B: { background: "#1c1c21", color: "#ededf0", border: AMBER },
  C: { background: "#1c1c21", color: "#ededf0", border: AMBER },
  D: { background: "#1c1c21", color: "#a1a1aa", border: AMBER },
};

/** The chip's style at `box` pixels square; letters shrink for SS and SSS so they keep the same margin. */
export function tierChipStyle(tier: string, box = 132): CSSProperties {
  const look = LOOK[tier] ?? LOOK.C;
  const size = Math.round(box * (tier.length >= 3 ? 0.4 : tier.length === 2 ? 0.48 : 0.58));
  const shadows = [look.ring ? `0 0 0 5px ${look.ring}` : null, look.glow ? `0 0 46px ${look.glow}` : null, "0 18px 40px rgba(0,0,0,0.5)"].filter(Boolean);
  return {
    display: "flex",
    width: box,
    height: box,
    borderRadius: Math.round(box * 0.23),
    alignItems: "center",
    justifyContent: "center",
    fontSize: size,
    fontWeight: 800,
    letterSpacing: tier.length > 1 ? -0.04 * size : 0,
    background: look.background,
    color: look.color,
    border: `3px solid ${look.border}`,
    boxShadow: shadows.join(", "),
  };
}
