import Link from "next/link";
import type { ReactNode } from "react";

/** A filter or tag chip; the selected one turns amber (aria-current="true" or aria-pressed). */
export const chip =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-edge bg-card px-3.5 text-sm font-medium transition hover:border-edge-strong aria-[current=true]:border-accent/60 aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent aria-pressed:border-accent/60 aria-pressed:bg-accent-soft aria-pressed:text-accent";

/** A static label chip (a tag on a card, a pass/fail fact). */
export const tag = "inline-flex h-6 items-center gap-1 rounded-full bg-raised px-2 text-xs font-medium text-mute ring-1 ring-inset ring-edge";

/**
 * A filter chip whose state lives in the address (`?tag=postmortem`). It is a
 * client-side route change, not a page load: only what reads the search
 * params re-renders (the list), the page keeps its scroll position and
 * layout, the URL still shows the filter, and Back steps through filters
 * only when `push` is set (default: replace, so Back leaves the page).
 * Ctrl or Cmd+click still opens the filtered view in a new tab.
 * Pair it with a fixed-height or min-height list area so nothing jumps.
 */
export function ChipLink({
  href,
  current,
  push = false,
  children,
}: {
  href: string;
  current?: boolean;
  push?: boolean;
  children: ReactNode;
}) {
  return (
    <Link href={href} replace={!push} scroll={false} aria-current={current ? "true" : undefined} className={chip}>
      {children}
    </Link>
  );
}

/** A chip that toggles in place (state kept in the component). */
export function ChipButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={chip}>
      {children}
    </button>
  );
}
