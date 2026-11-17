import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { INTERNAL_TOKEN_HEADER, REVALIDATE_PROFILES, internalToken } from "@/lib/internal-token.mjs";

// The Worker's hourly purge (worker/index.ts, pipeline/not-working.mjs
// purgeGoneProfiles) asks the app to drop its own cached copy of the profiles
// the health check hid or showed, before it purges the edge, so the next
// request renders the page as the site is now (not found while it is not
// working) instead of serving the copy from before.
//
// POST /api/internal/revalidate-profiles { urls: string[] } with the internal
// token (lib/internal-token.mjs) -> 200 { revalidated } | 404 (anyone else).
export const dynamic = "force-dynamic";

const MAX_URLS = 100;

export async function POST(req: Request) {
  const secret = process.env.AUTH_SECRET;
  const sent = req.headers.get(INTERNAL_TOKEN_HEADER) ?? "";
  // Not found for anyone without the token: the route is not there for them.
  if (!secret || !sent || sent !== (await internalToken(secret, REVALIDATE_PROFILES))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let urls: unknown = null;
  try {
    urls = ((await req.json()) as { urls?: unknown })?.urls;
  } catch {
    urls = null;
  }
  if (!Array.isArray(urls)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const list = urls.filter((u): u is string => typeof u === "string").slice(0, MAX_URLS);
  // A profile's slug is a whole encoded address, which Next does not match by its literal path, so the
  // profile route itself is revalidated: every cached profile renders again on its next visit (one render
  // each, and only in an hour when a profile was hidden or came back).
  if (list.length) revalidatePath("/p/[slug]", "page");
  return NextResponse.json({ revalidated: list.length }, { headers: { "cache-control": "no-store" } });
}
