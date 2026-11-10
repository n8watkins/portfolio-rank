import { ArrowDown, ArrowUp, FlaskConical, Minus } from "lucide-react";

/** Marks a value or block as made-up preview data. */
export function SampleTag({ what = "Sample data", className = "" }: { what?: string; className?: string }) {
  return (
    <span
      title={`${what}: this feature doesn't exist yet, the numbers are made up for the preview.`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-sample/40 px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-sample ${className}`}
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
  A: "bg-accent-soft text-accent",
  B: "bg-people-soft text-people",
  C: "bg-raised text-ink",
  D: "bg-raised text-mute",
};

export function TierBadge({ tier, size = "md" }: { tier: string; size?: "md" | "lg" }) {
  const s = size === "lg" ? "h-16 w-16 text-3xl rounded-2xl" : "h-8 w-8 text-sm rounded-lg";
  return (
    <span className={`grid grid-cols-1 shrink-0 place-items-center font-bold ${s} ${TIER_STYLE[tier] ?? TIER_STYLE.C}`} aria-label={`Tier ${tier}`}>
      {tier}
    </span>
  );
}

export const card = "rounded-2xl border border-edge bg-card";
export const btnPrimary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill transition hover:opacity-90 active:scale-[0.97]";
export const btnSecondary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-edge px-4 text-sm font-semibold transition hover:border-mute active:scale-[0.97]";
export const sectionTitle = "text-lg font-bold tracking-tight";
