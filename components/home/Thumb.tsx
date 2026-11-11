import { faviconOf } from "@/lib/shot-url";

/**
 * A small screenshot thumbnail at a fixed size (rows and lists), or the
 * site's icon on a quiet tile when there is no capture.
 */
export function Thumb({ src, domain, className = "" }: { src: string | null; domain: string; className?: string }) {
  if (!src)
    return (
      <span className={`grid shrink-0 place-items-center overflow-hidden border border-edge bg-raised ${className}`} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={faviconOf(domain)} alt="" width={16} height={16} loading="lazy" className="h-4 w-4 rounded" />
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" decoding="async" aria-hidden className={`shrink-0 border border-edge bg-raised object-cover object-top ${className}`} />
  );
}
