// Client-safe URL builders for images (no database access here).

export type Frame = "hero.jpg" | "mobile.jpg" | "full.jpg";

/**
 * One frame of a capture. `base` is `${SHOTS_BASE_URL}/${shot_key}`, optionally
 * with `?v=<version>` (lib/shots.ts), which goes after the file name so a
 * recapture gets a new URL and every version can be cached for good.
 */
export function frameOf(base: string, frame: Frame): string {
  const [path, query] = base.split("?");
  return `${path}/${frame}${query ? `?${query}` : ""}`;
}

/** A roster site's icon, served by the Worker (worker/assets.ts) with a placeholder when it has none. */
export function faviconOf(domain: string): string {
  return `/favicon/${domain}`;
}
