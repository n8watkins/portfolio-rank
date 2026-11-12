import { SHARE_SIZE, listedShareCard } from "@/lib/play/share-card";

// A listed portfolio's share card (lib/play/share-card.tsx), as its page's
// Open Graph image.

export const alt = "A portfolio on PortfolioRank";
export const size = SHARE_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return listedShareCard(decodeURIComponent(slug));
}
