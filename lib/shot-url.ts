// Client-safe URL builders for images (no database access here).

export type Frame = "hero.jpg" | "mobile.jpg" | "full-desktop.webp" | "full-phone.webp";

/**
 * One frame of a capture. `base` is `${SHOTS_BASE_URL}/${shot_key}`, optionally
 * with `?v=<version>` (lib/shots.ts), which goes after the file name so a
 * recapture gets a new URL and every version can be cached for good.
 */
export function frameOf(base: string, frame: Frame): string {
  const [path, query] = base.split("?");
  return `${path}/${frame}${query ? `?${query}` : ""}`;
}

/** One full-page frame as stored in portfolios.meta.fullPage (pipeline/fullpage.mjs). */
export type FullPageFrame = { width: number; height: number; pageHeight?: number; cropped?: boolean; bytes: number };
/** One full-page frame ready to show: its URL and size in pixels. `cropped`: the page goes on below `height`. */
export type FullPageShot = { src: string; width: number; height: number; cropped: boolean };
export type FullPagePreview = { desktop: FullPageShot; phone: FullPageShot };

const isFrame = (f: unknown): f is FullPageFrame => {
  const x = f as Partial<FullPageFrame> | null;
  return !!x && Number(x.bytes) > 0 && Number(x.width) > 0 && Number(x.height) > 0;
};

/**
 * The full-page frames of a capture, or null unless both were taken.
 * `base` is `${SHOTS_BASE_URL}/${shot_key}` (any ?v= on it is replaced):
 * the version is the frames' own capture time, since the backfill
 * (pipeline/fullpage-backfill.mjs) adds them to a capture later.
 */
export function fullPageFrames(base: string, fullPage: unknown): FullPagePreview | null {
  const fp = fullPage as { at?: string; desktop?: unknown; phone?: unknown } | null;
  if (!fp || !isFrame(fp.desktop) || !isFrame(fp.phone)) return null;
  const ms = Date.parse(String(fp.at ?? ""));
  const v = Number.isFinite(ms) ? `?v=${Math.floor(ms / 1000).toString(36)}` : "";
  const path = base.split("?")[0];
  const shot = (frame: Frame, f: FullPageFrame): FullPageShot => ({
    src: frameOf(`${path}${v}`, frame),
    width: f.width,
    height: f.height,
    cropped: Boolean(f.cropped),
  });
  return { desktop: shot("full-desktop.webp", fp.desktop), phone: shot("full-phone.webp", fp.phone) };
}

/** A roster site's icon, served by the Worker (worker/assets.ts) with a placeholder when it has none. */
export function faviconOf(domain: string): string {
  return `/favicon/${domain}`;
}
