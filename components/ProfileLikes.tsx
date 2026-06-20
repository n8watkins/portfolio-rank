"use client";

import { useState } from "react";
import { LikeButton } from "@/components/LikeButton";

export type LikeItem = { url: string; name: string; domain: string };

/**
 * The "Your likes" grid on the profile. Server-rendered initial set; unliking a
 * card removes it from view immediately (no refresh needed).
 */
export function ProfileLikes({ items }: { items: LikeItem[] }) {
  const [shown, setShown] = useState(items);

  if (shown.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-edge py-8 text-center text-sm text-mute">
        No likes yet. Tap the ♥ on any portfolio to save it here.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map((p) => (
        <div
          key={p.url}
          className="group flex items-center justify-between gap-2 rounded-xl border border-edge bg-card p-4"
        >
          <a
            href={`/p/${encodeURIComponent(p.url)}`}
            className="flex min-w-0 items-center gap-2.5"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://www.google.com/s2/favicons?domain=${p.domain}&sz=64`}
              alt=""
              loading="lazy"
              className="h-7 w-7 shrink-0 rounded-md bg-edge"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="truncate text-xs text-mute">{p.domain}</p>
            </div>
          </a>
          <LikeButton
            url={p.url}
            initialLiked
            variant="icon"
            onChange={(liked) => {
              if (!liked) setShown((s) => s.filter((x) => x.url !== p.url));
            }}
          />
        </div>
      ))}
    </div>
  );
}
