"use client";

import { useState } from "react";

/**
 * Copy text to the clipboard, degrading gracefully: the async Clipboard API
 * when available (secure contexts), otherwise a temp-textarea + execCommand
 * fallback for insecure contexts (HTTP over a LAN IP) where navigator.clipboard
 * is undefined. Returns whether the copy succeeded.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

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
    if (await copyToClipboard(href)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      // Nothing worked (rare) — surface the link so the user can copy it by hand.
      window.prompt("Copy this link:", href);
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
