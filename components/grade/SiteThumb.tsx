"use client";

import { useCallback, useState } from "react";
import { faviconOf } from "@/lib/shot-url";

/**
 * A small picture of another portfolio for the report's "Portfolios to learn
 * from": its screenshot from the top, else the site's icon, else the
 * person's initials on a quiet tile. Never an empty box.
 */
export function SiteThumb({ hero, domain, name }: { hero: string | null; domain: string; name: string }) {
  const [step, setStep] = useState<"shot" | "icon" | "initials">(hero ? "shot" : "icon");
  const next = useCallback(() => setStep((s) => (s === "shot" ? "icon" : "initials")), []);
  // An image that failed before hydration never fires onError: check on mount.
  const check = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth === 0) next();
    },
    [next],
  );
  const frame = "relative grid aspect-[16/10] w-20 shrink-0 place-items-center overflow-hidden rounded-md border border-edge bg-raised sm:w-24";
  if (step === "shot")
    return (
      <span className={frame} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={check} src={hero!} alt="" loading="lazy" decoding="async" onError={next} className="absolute inset-0 h-full w-full object-cover object-top" />
      </span>
    );
  if (step === "icon")
    return (
      <span className={frame} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={check} src={faviconOf(domain)} alt="" width={28} height={28} loading="lazy" onError={next} className="h-7 w-7 rounded-md" />
      </span>
    );
  return (
    <span className={`${frame} text-sm font-bold tracking-tight text-mute`} aria-hidden>
      {initialsOf(name || domain)}
    </span>
  );
}

/** "Aries Chang" gives "AC", "arefshalchi.com" gives "A". */
function initialsOf(name: string): string {
  const words = name
    .replace(/\.[a-z]{2,}$/i, "")
    .split(/[\s._-]+/)
    .filter((w) => /^\p{L}/u.test(w));
  const letters = words.slice(0, 2).map((w) => w[0].toUpperCase());
  return letters.join("") || name.slice(0, 1).toUpperCase();
}
