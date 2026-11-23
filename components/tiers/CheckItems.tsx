import type { CodeChecks } from "@/lib/tiers-view";

// The Code checks score item by item (lib/check-points.mjs): each item's
// points out of its maximum, "not measured yet" where the library median
// stands in. Shared by the tier card (RANKING_V2) and the profile's code
// checks card, so both show the same list.

export function CheckItems({ check }: { check: CodeChecks["check"] }) {
  return (
    <ul className="mt-2 grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
      {check.items.map((i) => (
        <li key={i.id} className="flex items-baseline justify-between gap-3 border-b border-edge py-1.5">
          <span className={i.measured ? "" : "text-mute"}>
            {i.name}
            {!i.measured && <span className="block text-[11px]">Not measured yet: library median</span>}
          </span>
          <span className={`shrink-0 tabular-nums ${i.measured && i.points >= i.max ? "text-up" : "text-mute"}`}>{`${i.points}/${i.max}`}</span>
        </li>
      ))}
    </ul>
  );
}
