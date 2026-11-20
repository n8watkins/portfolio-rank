"use client";

import type { ReactNode } from "react";
import { Link2 } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";

// A post's share links: X, LinkedIn and Bluesky intents, and copy the link.
// The brand marks are inline SVG (Simple Icons paths, CC0), since lucide has no
// brand icons; each link says where it shares in its aria-label.

const shareLinkClass =
  "inline-flex h-11 items-center gap-2 rounded-lg border border-edge bg-card px-3 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong hover:text-ink sm:h-9";

function Mark({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden focusable="false">
      <path d={path} />
    </svg>
  );
}

const X_PATH = "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";
const LINKEDIN_PATH =
  "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125ZM7.119 20.452H3.555V9h3.564v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z";
const BLUESKY_PATH =
  "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026";

function Share({ href, label, name, children }: { href: string; label: string; name: string; children: ReactNode }) {
  return (
    <a className={shareLinkClass} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
      <span>{name}</span>
    </a>
  );
}

export function ShareLinks({ url, text }: { url: string; text: string }) {
  const q = encodeURIComponent;
  return (
    <div className="flex flex-wrap gap-2">
      <Share href={`https://x.com/intent/post?text=${q(text)}&url=${q(url)}`} label="Share on X (opens in a new tab)" name="X">
        <Mark path={X_PATH} />
      </Share>
      <Share href={`https://www.linkedin.com/sharing/share-offsite/?url=${q(url)}`} label="Share on LinkedIn (opens in a new tab)" name="LinkedIn">
        <Mark path={LINKEDIN_PATH} />
      </Share>
      <Share href={`https://bsky.app/intent/compose?text=${q(`${text} ${url}`)}`} label="Share on Bluesky (opens in a new tab)" name="Bluesky">
        <Mark path={BLUESKY_PATH} />
      </Share>
      <CopyButton text={url} label="Copy link" icon={Link2} ariaLabel="Copy the link to this post" />
    </div>
  );
}
