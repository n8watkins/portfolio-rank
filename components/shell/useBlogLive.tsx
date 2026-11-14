"use client";

import { createContext, useContext, useEffect, useState } from "react";

// The shell shows its Blog links (header, footer, the phone's More sheet)
// only once a post is published (owner, 2026-11-11); /blog itself is always
// reachable. The server decides while it renders the shell
// (lib/blog-live.ts, through BlogLiveProvider), so on a site with posts the
// links are in the HTML and nothing is fetched. Only when the server said
// "not yet" (a page rendered before the first post, or a failed read) does
// the browser ask /api/blog/live, at most once every 10 minutes per browser,
// and the link joins the end of the nav without moving anything else.
// Once the blog always has posts, this gate can go.

const KEY = "pr-blog-live";
const RECHECK_MS = 10 * 60_000;
let pending: Promise<boolean> | null = null;

const ServerSaid = createContext(false);

export function BlogLiveProvider({ live, children }: { live: boolean; children: React.ReactNode }) {
  return <ServerSaid.Provider value={live}>{children}</ServerSaid.Provider>;
}

/** The browser's last answer: true, false, or null when unknown or stale. */
function remembered(): boolean | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { live?: boolean; at?: number } | null;
    if (!v || typeof v.live !== "boolean") return null;
    if (v.live) return true;
    return Date.now() - Number(v.at ?? 0) < RECHECK_MS ? false : null;
  } catch {
    return null;
  }
}

function ask(): Promise<boolean> {
  const known = remembered();
  if (known !== null) return Promise.resolve(known);
  pending ??= fetch("/api/blog/live")
    .then((r) => (r.ok ? r.json() : { live: false }))
    .then((b: { live?: boolean }) => {
      const live = b.live === true;
      try {
        localStorage.setItem(KEY, JSON.stringify({ live, at: Date.now() }));
      } catch {
        /* storage blocked: ask again next page */
      }
      return live;
    })
    .catch(() => false);
  return pending;
}

/** True once the blog has a published post. */
export function useBlogLive(): boolean {
  const serverSaid = useContext(ServerSaid);
  const [live, setLive] = useState(serverSaid);
  useEffect(() => {
    if (serverSaid) return;
    let alive = true;
    ask().then((v) => alive && v && setLive(true));
    return () => {
      alive = false;
    };
  }, [serverSaid]);
  return serverSaid || live;
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
