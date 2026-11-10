"use client";

import { useEffect, useRef, useState } from "react";
import { useSignIn } from "@/components/SignInModal";

type Variant = "button" | "icon";

const SIGN_IN_PROMPT = {
  title: "Sign in to like portfolios",
  body: "Likes are saved to your profile so you can find them later. Sign in to start liking.",
};

/**
 * Heart toggle for liking (= personal bookmark, separate from the ⭐ super-vote).
 * Optimistic: flips instantly, reverts on error, and opens the sign-in modal if
 * the rater is anon (403 signin_required). `initialLiked` may arrive async (a
 * batched /api/likes hydrate), so it's adopted until the user interacts.
 */
export function LikeButton({
  url,
  hydrate = false,
  name,
  initialLiked = false,
  count,
  showCount = false,
  variant = "button",
  className = "",
  onChange,
}: {
  url: string;
  /** Look up whether the visitor likes it (for pages cached for everyone). */
  hydrate?: boolean;
  /** The portfolio's name, so a screen reader hears "Like Jane Doe", not a row of "Like". */
  name?: string;
  initialLiked?: boolean;
  count?: number;
  showCount?: boolean;
  variant?: Variant;
  className?: string;
  /** createdAt is the removed like's date on an unlike, for an Undo that restores its place. */
  onChange?: (liked: boolean, info?: { createdAt?: string }) => void;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [n, setN] = useState(count ?? 0);
  const [busy, setBusy] = useState(false);
  const openSignIn = useSignIn();
  const touched = useRef(false);

  // Adopt a late-arriving initial state (e.g. grid hydrate) until first click.
  useEffect(() => {
    if (!touched.current) setLiked(initialLiked);
  }, [initialLiked]);
  useEffect(() => {
    if (typeof count === "number" && !touched.current) setN(count);
  }, [count]);
  useEffect(() => {
    if (!hydrate) return;
    let live = true;
    fetch(`/api/likes?urls=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && !touched.current && Array.isArray(d?.liked)) setLiked(d.liked.includes(url));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hydrate, url]);

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    touched.current = true;
    const next = !liked;
    setBusy(true);
    setLiked(next); // optimistic visual flip
    setN((c) => Math.max(0, c + (next ? 1 : -1)));
    // onChange fires ONCE, with the *committed* result, so consumers that act
    // destructively (e.g. ProfileLikes removing the card on unlike) never act
    // on an optimistic flip that the server then rejects.
    let committed = next;
    let createdAt: string | undefined;
    try {
      const res = await fetch("/api/likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, want: next }),
      });
      if (res.status === 403) {
        // anon → revert + prompt sign-in
        committed = !next;
        setLiked(!next);
        setN((c) => Math.max(0, c + (next ? -1 : 1)));
        openSignIn(SIGN_IN_PROMPT);
      } else if (res.ok) {
        const data = await res.json();
        if (typeof data.liked === "boolean") {
          committed = data.liked;
          setLiked(data.liked);
        }
        if (typeof data.count === "number") setN(data.count);
        if (typeof data.createdAt === "string") createdAt = data.createdAt;
      } else {
        committed = !next;
        setLiked(!next);
        setN((c) => Math.max(0, c + (next ? -1 : 1)));
      }
    } catch {
      committed = !next;
      setLiked(!next);
      setN((c) => Math.max(0, c + (next ? -1 : 1)));
    }
    onChange?.(committed, { createdAt });
    setBusy(false);
  };

  const heart = liked ? "♥" : "♡";
  const label = `${liked ? "Liked" : "Like"}${showCount && n > 0 ? ` · ${n}` : ""}`;

  if (variant === "icon") {
    return (
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={liked}
        aria-label={name ? `Like ${name}` : "Like"}
        title={liked ? "Liked - click to remove" : "Like (save to your profile)"}
        // The ::after pad grows the tap target to 44px without moving anything.
        className={`${/\b(absolute|fixed|sticky)\b/.test(className) ? "" : "relative"} rounded-full bg-bg/80 px-2 py-1 text-sm backdrop-blur transition after:absolute after:-inset-2 hover:bg-bg ${
          liked ? "text-rose-400" : "text-mute hover:text-rose-400"
        } ${className}`}
      >
        <span aria-hidden>{heart}</span>
        {showCount && n > 0 && (
          <span className="ml-1 text-xs tabular-nums">{n}</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={liked}
      aria-label={name ? `Like ${name}${showCount && n > 0 ? `, ${n} ${n === 1 ? "like" : "likes"}` : ""}` : undefined}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
        liked
          ? "border-rose-400/50 bg-rose-400/10 text-rose-400"
          : "border-edge text-mute hover:border-rose-400/50 hover:text-rose-400"
      } ${className}`}
    >
      <span aria-hidden className="text-base leading-none">{heart}</span>
      {label}
    </button>
  );
}
