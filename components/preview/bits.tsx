import { ArrowDown, ArrowUp, FlaskConical, Minus } from "lucide-react";

/** Marks a value or block as made-up preview data. */
export function SampleTag({ what = "Sample data", className = "" }: { what?: string; className?: string }) {
  return (
    <span
      title={`${what}: this feature doesn't exist yet, the numbers are made up for the preview.`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-edge-strong px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-mute ${className}`}
    >
      <FlaskConical className="h-3 w-3" aria-hidden />
      Sample
    </span>
  );
}

export function Movement({ move, className = "" }: { move: number; className?: string }) {
  if (move === 0)
    return (
      <span className={`inline-flex items-center text-mute ${className}`} aria-label="No change this week">
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  const up = move > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${up ? "text-up" : "text-down"} ${className}`}
      aria-label={`${up ? "Up" : "Down"} ${Math.abs(move)} this week`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {Math.abs(move)}
    </span>
  );
}

export const TIER_STYLE: Record<string, string> = {
  S: "bg-fill text-on-fill",
  A: "bg-accent-soft text-accent ring-1 ring-inset ring-accent/25",
  B: "bg-raised text-ink ring-1 ring-inset ring-edge-strong",
  C: "bg-raised text-ink ring-1 ring-inset ring-edge",
  D: "bg-raised text-mute ring-1 ring-inset ring-edge",
};

export function TierBadge({ tier, size = "md" }: { tier: string; size?: "md" | "lg" }) {
  const s = size === "lg" ? "h-16 w-16 text-3xl rounded-2xl" : "h-8 w-8 text-sm rounded-lg";
  return (
    <span className={`grid grid-cols-1 shrink-0 place-items-center font-bold ${s} ${TIER_STYLE[tier] ?? TIER_STYLE.C}`} aria-label={`Tier ${tier}`}>
      {tier}
    </span>
  );
}

export const card = "card";
export const btnPrimary =
  "group inline-flex h-11 items-center justify-center gap-2 btn-sheen rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill transition active:scale-[0.97]";
export const btnSecondary =
  "group inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97]";
export const sectionTitle = "text-lg font-bold tracking-tight";

const MEDAL: Record<number, { name: string; ring: string; fill: string }> = {
  1: { name: "Gold", ring: "#e9b949", fill: "linear-gradient(145deg, #fde68a, #e9b949 55%, #b7861c)" },
  2: { name: "Silver", ring: "#b9bec8", fill: "linear-gradient(145deg, #f4f5f7, #c3c8d1 55%, #8d94a1)" },
  3: { name: "Bronze", ring: "#c48a5c", fill: "linear-gradient(145deg, #f3c9a4, #c48a5c 55%, #8f5a33)" },
};

/** Rank 1-3 get a gold, silver or bronze medal; the rest a plain number. */
export function RankBadge({ rank, tied, size = "md" }: { rank: number; tied?: boolean; size?: "md" | "lg" }) {
  const m = MEDAL[rank];
  if (!m)
    return <span className="text-sm font-bold tabular-nums text-mute">{tied ? `=${rank}` : rank}</span>;
  const s = size === "lg" ? "h-9 w-9 text-sm" : "h-7 w-7 text-xs";
  return (
    <span
      className={`medal inline-grid shrink-0 place-items-center rounded-full font-bold tabular-nums text-[#1a1405] ${s}`}
      style={{ background: m.fill, boxShadow: `0 0 0 2px var(--color-card), 0 0 0 3.5px ${m.ring}, 0 4px 10px -4px ${m.ring}` }}
      aria-label={`${m.name}, rank ${tied ? "=" : ""}${rank}`}
    >
      {tied ? `=${rank}` : rank}
    </span>
  );
}
