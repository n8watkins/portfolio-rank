import type { ReactNode } from "react";

/** A filter or tag chip; the selected one turns amber (aria-current="true"). */
export const chip =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-edge bg-card px-3.5 text-sm font-medium transition hover:border-edge-strong aria-[current=true]:border-accent/60 aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent aria-pressed:border-accent/60 aria-pressed:bg-accent-soft aria-pressed:text-accent";

/** A static label chip (a tag on a card, a pass/fail fact). */
export const tag = "inline-flex h-6 items-center gap-1 rounded-full bg-raised px-2 text-xs font-medium text-mute ring-1 ring-inset ring-edge";

/** A chip that links somewhere (filters that live in the address). */
export function ChipLink({ href, current, children }: { href: string; current?: boolean; children: ReactNode }) {
  return (
    <a href={href} aria-current={current ? "true" : undefined} className={chip}>
      {children}
    </a>
  );
}

/** A chip that toggles in place. */
export function ChipButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={chip}>
      {children}
    </button>
  );
}
