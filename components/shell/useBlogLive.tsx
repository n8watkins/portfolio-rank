"use client";

import { useEffect, useState } from "react";

// The shell shows its Blog links (header, footer, the phone's More sheet)
// only once a post is published (owner, 2026-11-11); /blog itself is always
// reachable. The answer comes from /api/blog/live (cached 5 minutes) once
// per page load and is remembered for the tab, so links don't blink between
// pages (a "not yet" is asked again on the next page load). Once the blog always has posts, this gate can go.

const KEY = "pr-blog-live";
let pending: Promise<boolean> | null = null;

function remembered(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function ask(): Promise<boolean> {
  // Once live in this tab, it stays live: a blog rarely loses its last post.
  if (remembered()) return Promise.resolve(true);
  pending ??= fetch("/api/blog/live")
    .then((r) => (r.ok ? r.json() : { live: false }))
    .then((b: { live?: boolean }) => {
      const live = b.live === true;
      try {
        sessionStorage.setItem(KEY, live ? "1" : "0");
      } catch {
        /* storage blocked: ask again next page */
      }
      return live;
    })
    .catch(() => false);
  return pending;
}

/** True once the blog has a published post; false until then (and on the server). */
export function useBlogLive(): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    ask().then((v) => alive && setLive(v));
    return () => {
      alive = false;
    };
  }, []);
  return live;
}

/** The footer's Blog link, shown once the blog has a published post. */
export function BlogFooterLink({ href, className }: { href: string; className: string }) {
  const live = useBlogLive();
  if (!live) return null;
  return (
    <li>
      <a href={href} className={className}>
        Blog
      </a>
    </li>
  );
}
