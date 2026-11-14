// Client-safe URL builders for images (no database access here).

export type Frame = "hero.jpg" | "mobile.jpg";

/**
 * One frame of a capture. `base` is `${SHOTS_BASE_URL}/${shot_key}`, optionally
 * with `?v=<version>` (lib/shots.ts), which goes after the file name so a
 * recapture gets a new URL and every version can be cached for good.
 */
export function frameOf(base: string, frame: Frame): string {
  const [path, query] = base.split("?");
  return `${path}/${frame}${query ? `?${query}` : ""}`;
}

/** One view as stored in portfolios.meta.fullPage (pipeline/fullpage.mjs captureView). */
export type FullPageFrame = { width: number; height: number; pageHeight?: number; cropped?: boolean; bytes: number };
/**
 * One view ready to show: the tall image (`src`, `width` x `height`), its
 * top's thumbnail (`thumb`, `thumbWidth` wide), and `topHeight`, the
 * screenful at the top: a box of `width` / `topHeight` with the tall image
 * at object-position top shows the old hero without a separate file.
 * `cropped`: the page goes on below `height`.
 */
export type FullPageShot = { src: string; thumb: string; thumbWidth: number; width: number; height: number; topHeight: number; cropped: boolean };
export type FullPagePreview = { desktop: FullPageShot; phone: FullPageShot };

const isFrame = (f: unknown): f is FullPageFrame => {
  const x = f as Partial<FullPageFrame> | null;
  return !!x && Number(x.bytes) > 0 && Number(x.width) > 0 && Number(x.height) > 0;
};

// pipeline/fullpage.mjs FRAMES and IMAGE_FILES.
const VIEWS = {
  desktop: { tall: "desktop.avif", thumb: "desktop-thumb.avif", thumbWidth: 480, topHeight: 900 },
  phone: { tall: "phone.avif", thumb: "phone-thumb.avif", thumbWidth: 240, topHeight: 844 },
} as const;

/**
 * The tall images and thumbnails of a capture, or null unless both views
 * were taken. `base` is `${SHOTS_BASE_URL}/${shot_key}` (any ?v= on it is
 * dropped): the files sit under their own version, <shot_key>/<v>/, and
 * never change, so they can be cached for good.
 */
export function fullPageFrames(base: string, fullPage: unknown): FullPagePreview | null {
  const fp = fullPage as { v?: string; desktop?: unknown; phone?: unknown } | null;
  if (!fp || !/^[0-9a-z]{1,16}$/.test(String(fp.v ?? "")) || !isFrame(fp.desktop) || !isFrame(fp.phone)) return null;
  const dir = `${base.split("?")[0]}/${fp.v}`;
  const shot = (name: keyof typeof VIEWS, f: FullPageFrame): FullPageShot => ({
    src: `${dir}/${VIEWS[name].tall}`,
    thumb: `${dir}/${VIEWS[name].thumb}`,
    thumbWidth: VIEWS[name].thumbWidth,
    width: f.width,
    height: f.height,
    topHeight: Math.min(VIEWS[name].topHeight, f.height),
    cropped: Boolean(f.cropped),
  });
  return { desktop: shot("desktop", fp.desktop), phone: shot("phone", fp.phone) };
}

/** A roster site's icon, served by the Worker (worker/assets.ts) with a placeholder when it has none. */
export function faviconOf(domain: string): string {
  return `/favicon/${domain}`;
}
