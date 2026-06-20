"use client";

import { useEffect, useRef, useState } from "react";
import { SignInModal } from "@/components/SignInModal";

type Variant = "button" | "icon";

/**
 * Heart toggle for liking (= personal bookmark, separate from the ⭐ super-vote).
 * Optimistic: flips instantly, reverts on error, and opens the sign-in modal if
 * the rater is anon (403 signin_required). `initialLiked` may arrive async (a
 * batched /api/likes hydrate), so it's adopted until the user interacts.
 */
export function LikeButton({
  url,
  initialLiked = false,
  count,
  showCount = false,
  variant = "button",
  className = "",
  onChange,
}: {
  url: string;
  initialLiked?: boolean;
  count?: number;
  showCount?: boolean;
  variant?: Variant;
  className?: string;
  onChange?: (liked: boolean) => void;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [n, setN] = useState(count ?? 0);
  const [busy, setBusy] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const touched = useRef(false);

  // Adopt a late-arriving initial state (e.g. grid hydrate) until first click.
  useEffect(() => {
    if (!touched.current) setLiked(initialLiked);
  }, [initialLiked]);
  useEffect(() => {
    if (typeof count === "number" && !touched.current) setN(count);
  }, [count]);

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    touched.current = true;
    const next = !liked;
    setBusy(true);
    setLiked(next); // optimistic
    setN((c) => Math.max(0, c + (next ? 1 : -1)));
    onChange?.(next);
    try {
      const res = await fetch("/api/likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, want: next }),
      });
      if (res.status === 403) {
        // anon → revert + prompt sign-in
        setLiked(!next);
        setN((c) => Math.max(0, c + (next ? -1 : 1)));
        onChange?.(!next);
        setSignInOpen(true);
      } else if (res.ok) {
        const data = await res.json();
        if (typeof data.liked === "boolean") setLiked(data.liked);
        if (typeof data.count === "number") setN(data.count);
      } else {
        setLiked(!next);
        setN((c) => Math.max(0, c + (next ? -1 : 1)));
        onChange?.(!next);
      }
    } catch {
      setLiked(!next);
      setN((c) => Math.max(0, c + (next ? -1 : 1)));
      onChange?.(!next);
    }
    setBusy(false);
  };

  const heart = liked ? "♥" : "♡";
  const label = `${liked ? "Liked" : "Like"}${showCount && n > 0 ? ` · ${n}` : ""}`;

  if (variant === "icon") {
    return (
      <>
        <button
          onClick={toggle}
          disabled={busy}
          aria-pressed={liked}
          aria-label={liked ? "Unlike" : "Like"}
          title={liked ? "Liked — click to remove" : "Like (save to your profile)"}
          className={`rounded-full bg-bg/80 px-2 py-1 text-sm backdrop-blur transition hover:bg-bg ${
            liked ? "text-rose-400" : "text-mute hover:text-rose-400"
          } ${className}`}
        >
          {heart}
          {showCount && n > 0 && (
            <span className="ml-1 text-xs tabular-nums">{n}</span>
          )}
        </button>
        <SignInModal
          open={signInOpen}
          onClose={() => setSignInOpen(false)}
          title="Sign in to like portfolios"
          body="Likes are saved to your profile so you can find them later. Sign in to start liking."
        />
      </>
    );
  }

  return (
    <>
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={liked}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
          liked
            ? "border-rose-400/50 bg-rose-400/10 text-rose-400"
            : "border-edge text-mute hover:border-rose-400/50 hover:text-rose-400"
        } ${className}`}
      >
        <span className="text-base leading-none">{heart}</span>
        {label}
      </button>
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        title="Sign in to like portfolios"
        body="Likes are saved to your profile so you can find them later. Sign in to start liking."
      />
    </>
  );
}
