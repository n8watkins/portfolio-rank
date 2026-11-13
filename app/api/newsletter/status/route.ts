import { NextResponse } from "next/server";
import { newsletterLive } from "@/lib/newsletter/server";

// GET /api/newsletter/status -> { on }: whether the newsletter is live
// (NEWSLETTER_ENABLED and the owner's switch). The sign-up forms ask once per
// page load (components/newsletter/useNewsletterOn.ts) instead of reading it
// at render time, because the blog's pages are cached at the edge for days
// and a switch must take effect within a minute. Browsers keep the answer 60
// seconds.
export const dynamic = "force-dynamic";

export async function GET() {
  const on = await newsletterLive().catch(() => false);
  return NextResponse.json({ on }, { headers: { "cache-control": "public, max-age=60", "x-robots-tag": "noindex" } });
}
