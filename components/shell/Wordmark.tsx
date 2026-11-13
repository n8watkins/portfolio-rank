import Link from "next/link";

/** The logo and name; goes home. No prefetch: on every page it cost three requests for a page rarely opened from here. */
export function Wordmark() {
  return (
    <Link href="/" prefetch={false} className="flex shrink-0 items-center gap-2.5 rounded-lg text-[17px] font-bold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/pr-logo.svg" alt="" width={32} height={32} className="h-8 w-8" />
      <span>
        Portfolio<span className="text-accent">Rank</span>
      </span>
    </Link>
  );
}
