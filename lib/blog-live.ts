import { db, ensureSchema } from "@/lib/db";
import { hasPublished } from "@/lib/content/blog.mjs";

// Whether the blog has a live post, read while the shell renders on the
// server (components/shell/AppShell.tsx), so the Blog links are in the HTML
// rather than popping in after load. Remembered for a minute per isolate:
// one indexed read covers every render in that minute. Any failure (no
// database during a build, a network blip) answers false, and the browser
// then asks /api/blog/live once (components/shell/useBlogLive.tsx).

const TTL_MS = 60_000;
let cached: { live: boolean; at: number } | null = null;

export async function blogLiveAtRender(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.live;
  try {
    await ensureSchema();
    const live = await hasPublished(db(), { now: new Date(now) });
    cached = { live, at: now };
    return live;
  } catch {
    return false;
  }
}
