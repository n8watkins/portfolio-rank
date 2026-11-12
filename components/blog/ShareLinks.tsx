"use client";

import { Link2 } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";

// A post's share links: X, LinkedIn and Bluesky intents, and copy the link.

const shareLinkClass =
  "inline-flex h-11 items-center gap-1.5 rounded-lg border border-edge bg-card px-3 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong sm:h-9";

export function ShareLinks({ url, text }: { url: string; text: string }) {
  const q = encodeURIComponent;
  return (
    <div className="flex flex-wrap gap-2">
      <a className={shareLinkClass} href={`https://x.com/intent/post?text=${q(text)}&url=${q(url)}`} target="_blank" rel="noopener noreferrer">
        Post on X
      </a>
      <a className={shareLinkClass} href={`https://www.linkedin.com/sharing/share-offsite/?url=${q(url)}`} target="_blank" rel="noopener noreferrer">
        LinkedIn
      </a>
      <a className={shareLinkClass} href={`https://bsky.app/intent/compose?text=${q(`${text} ${url}`)}`} target="_blank" rel="noopener noreferrer">
        Bluesky
      </a>
      <CopyButton text={url} label="Copy link" icon={Link2} />
    </div>
  );
}
