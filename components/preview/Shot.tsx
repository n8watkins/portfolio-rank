"use client";

import { useState } from "react";

/** A capture from the shots bucket; a quiet placeholder when there is none. */
export function Shot({
  base,
  kind = "hero",
  alt,
  domain,
  className = "",
  eager = false,
}: {
  base: string;
  kind?: "hero" | "mobile";
  alt: string;
  domain: string;
  className?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div role="img" aria-label={alt} className={`grid grid-cols-1 place-items-center bg-raised p-3 text-center text-xs text-mute ${className}`}>
        <span className="break-all">{domain}</span>
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${base}/${kind}.jpg`}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
      className={`bg-raised object-cover object-top ${className}`}
    />
  );
}
