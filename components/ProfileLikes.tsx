"use client";

import { useState } from "react";
import { LikeButton } from "@/components/LikeButton";
import { useUndoToast } from "@/components/UndoToast";
import { faviconOf } from "@/lib/shot-url";
import { profilePath } from "@/lib/profile-url.mjs";

export type LikeItem = { url: string; name: string; domain: string };

/**
 * The "Your likes" grid on the profile. Server-rendered initial set; unliking a
 * card removes it from view immediately, with an Undo toast that likes it again
 * in the same place.
 */
export function ProfileLikes({ items }: { items: LikeItem[] }) {
  const [shown, setShown] = useState(items);
  const showUndo = useUndoToast();

  const unliked = (item: LikeItem, createdAt?: string) => {
    const index = shown.findIndex((x) => x.url === item.url);
    setShown((s) => s.filter((x) => x.url !== item.url));
    showUndo({
      id: `like:${item.url}`,
      message: `Removed ${item.name} from your likes`,
      undo: async () => {
        const res = await fetch("/api/likes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url, want: true, createdAt }),
        });
        if (!res.ok) throw new Error("restore_failed");
        setShown((s) =>
          s.some((x) => x.url === item.url) ? s : [...s.slice(0, index), item, ...s.slice(index)]
        );
      },
    });
  };

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
            href={profilePath(p.url)}
            className="flex min-w-0 items-center gap-2.5"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={faviconOf(p.domain)}
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
            name={p.name}
            initialLiked
            variant="icon"
            onChange={(liked, info) => {
              if (!liked) unliked(p, info?.createdAt);
            }}
          />
        </div>
      ))}
    </div>
  );
}
