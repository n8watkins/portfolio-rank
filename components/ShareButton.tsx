"use client";

import { useState } from "react";

/**
 * Share a URL: the native share sheet where available (mobile), otherwise copy
 * the link to the clipboard with a brief "Copied!" confirmation. `url` defaults
 * to the current page, so it works for both a portfolio and a shared list.
 */
export function ShareButton({
  url,
  title,
  label = "Share",
  className = "",
}: {
  url?: string;
  title?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const share = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const href = url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url: href });
        return;
      } catch {
        // user dismissed the sheet, or share failed — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — nothing graceful to do */
    }
  };

  return (
    <button
      onClick={share}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink ${className}`}
      title="Share"
    >
      {copied ? "✓ Copied!" : `↗ ${label}`}
    </button>
  );
}
