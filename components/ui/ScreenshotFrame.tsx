"use client";

import { useCallback, useState } from "react";
import { Globe } from "lucide-react";
import { faviconOf } from "@/lib/shot-url";

/** A capture below this score (0-100: detail, contrast, not blank, no cookie bar) shows the fallback. */
export const MIN_SHOT_QUALITY = 30;

const ASPECT = {
  hero: "aspect-[16/10]", // 1440 x 900 desktop capture
  mobile: "aspect-[390/844]", // 390 x 844 phone capture
} as const;

/**
 * A portfolio screenshot in a fixed-ratio frame, so nothing shifts while it
 * loads. It falls back to the site's icon and domain on a quiet surface when
 * there is no capture, the capture fails to load, comes back implausibly
 * small (a blank or broken frame), or its quality score is below the bar.
 */
export function ScreenshotFrame({
  src,
  alt,
  domain,
  kind = "hero",
  quality,
  minQuality = MIN_SHOT_QUALITY,
  eager = false,
  className = "",
}: {
  /** The image URL (heroOf/mobileOf from lib/shots.ts, or mShots); null for none. */
  src: string | null;
  alt: string;
  domain: string;
  kind?: keyof typeof ASPECT;
  /** The capture's quality score, when the pipeline has one. */
  quality?: number | null;
  minQuality?: number;
  /** Above the fold: load at once and at high priority (LCP). */
  eager?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  // Same for the site's icon in the fallback.
  const checkIcon = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) setIconFailed(true);
  }, []);
  // An image that failed before hydration never fires onError: check on mount.
  const check = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth < 100) setFailed(true);
  }, []);
  const poor = typeof quality === "number" && quality < minQuality;
  const frame = `relative overflow-hidden bg-raised ${ASPECT[kind]} ${className}`;
  if (!src || failed || poor)
    return (
      <div role="img" aria-label={alt} className={`${frame} grid place-items-center bg-linear-to-b from-raised to-card p-3 text-center`}>
        <span className="flex min-w-0 flex-col items-center gap-2">
          {iconFailed ? (
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-card text-mute ring-1 ring-edge">
              <Globe className="h-4 w-4" aria-hidden />
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={checkIcon}
              src={faviconOf(domain)}
              alt=""
              width={32}
              height={32}
              loading="lazy"
              onError={() => setIconFailed(true)}
              className="h-8 w-8 rounded-lg"
            />
          )}
          <span className="max-w-full break-all text-xs font-medium text-mute">{domain}</span>
        </span>
      </div>
    );
  return (
    <div className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={check}
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        decoding="async"
        onError={() => setFailed(true)}
        onLoad={(e) => {
          // A real capture is hundreds of pixels wide; a few pixels is a blank or broken frame.
          if (e.currentTarget.naturalWidth < 100) setFailed(true);
        }}
        className="absolute inset-0 h-full w-full object-cover object-top"
      />
    </div>
  );
}
