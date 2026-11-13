import { listedShareCard } from "@/lib/play/share-card";
import { profileUrlFor } from "@/lib/profile";
import { requestedSlug, slugKey } from "@/lib/profile-url.mjs";

// A portfolio's share card (lib/play/share-card.tsx), its profile's Open
// Graph image: /og/p/<host><path>, the profile's own address under /og
// (lib/profile-url.mjs profileImagePath). It can't be the page's
// opengraph-image, because the page is a catch-all route (app/p/[...slug])
// and Next.js allows nothing under one.

export const revalidate = 3600;

export async function generateStaticParams() {
  return [];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const key = slugKey(requestedSlug(slug));
  const url = key ? await profileUrlFor(key) : null;
  if (!url) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return listedShareCard(url);
}
