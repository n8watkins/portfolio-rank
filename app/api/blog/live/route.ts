import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { cachedResponse } from "@/lib/edge-cache";
import { hasPublished } from "@/lib/content/blog.mjs";

// Whether the blog has a published post, for the shell's Blog links
// (components/shell/useBlogLive.ts): { "live": true | false }. Cached at the
// edge and in browsers for 5 minutes, like the blog pages, so it costs one
// database read per data center per 5 minutes.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return cachedResponse(`${new URL(req.url).origin}/api/blog/live`, async () => {
    await ensureSchema();
    const live = await hasPublished(db(), { now: new Date() });
    return NextResponse.json({ live }, { headers: { "cache-control": "public, max-age=300" } });
  });
}
