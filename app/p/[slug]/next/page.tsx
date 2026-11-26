import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileNext } from "@/components/profile-next/ProfileNext";
import { profileNextEnabled } from "@/lib/profile-next/flag";
import { loadNextProfile } from "@/lib/profile-next/load";

// The redesigned profile (the owner's "Banner" pick, 2026-11-25), at
// /p/<address>/next while PROFILE_NEXT is "true" (lib/profile-next/flag.ts);
// a 404 otherwise. Noindex (here and in the X-Robots-Tag header,
// next.config.ts), outside the sitemap and linked from nowhere, so the
// current profile at /p/<address> stays the one people and search engines
// see until it replaces it. Like the current profile it is rendered once and
// kept for 5 minutes (ISR): nothing here depends on who is looking.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

/** The page's own share card (./card/route.tsx). */
const cardPath = (slug: string) => `/p/${slug}/next/card`;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  if (!profileNextEnabled()) return {};
  const { slug } = await params;
  const d = await loadNextProfile(decodeURIComponent(slug));
  if (!d) return {};
  const title = `${d.p.name} - PortfolioRank`;
  const description = d.p.tagline ? `${d.p.tagline} · ${d.p.domain}` : `Developer portfolio · ${d.p.domain}`;
  const image = cardPath(encodeURIComponent(d.p.url));
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "profile", images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function ProfileNextPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!profileNextEnabled()) notFound();
  const { slug } = await params;
  const d = await loadNextProfile(decodeURIComponent(slug));
  // A site that is not working, or one its owner removed, has no public page (as on the current profile).
  if (!d) notFound();
  return <ProfileNext d={d} cardImage={cardPath(encodeURIComponent(d.p.url))} />;
}
