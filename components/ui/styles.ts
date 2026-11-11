// Class names for the shared building blocks, so every page draws buttons,
// cards and headings the same way. Surfaces and depth are CSS classes in
// app/globals.css: `.card` (a surface with depth), `.card-hover` (a card that
// is a link: lifts on hover), `.card-featured` (amber hairline), `.icon-tile`,
// `.band` / `.band-raised` / `.band-glow` / `.band-rule` (full-width page
// sections) and `.wrap` (the one content width).

/** The amber call to action. One per view. */
export const btnPrimary =
  "group btn-sheen inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-fill px-5 text-sm font-semibold text-on-fill transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/** Every other button or button-like link. */
export const btnSecondary =
  "group inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/** A quiet text button (Cancel, Skip). */
export const btnGhost =
  "group inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-mute transition hover:bg-raised hover:text-ink active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/**
 * A round icon-only button with a 44 px target (owner, 2026-11-10: the hero
 * deck's previous, next and pause). Give it an aria-label.
 */
export const btnIcon =
  "inline-grid h-11 w-11 shrink-0 place-items-center rounded-full border border-edge-strong bg-card text-ink shadow-[var(--card-hi),var(--card-drop)] transition hover:border-accent/60 hover:text-accent active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40";

/** A small uppercase label above a heading. */
export const eyebrow = "text-xs font-semibold uppercase tracking-[0.14em] text-accent";

/** A section's heading. */
export const sectionTitle = "text-lg font-bold tracking-tight";
