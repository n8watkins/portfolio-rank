import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { hiddenUrls } from "@/lib/roster";

const BASE = SITE_URL;

// Rebuilt once a day: sites the health check hides (down, dead or parked)
// drop out, so search engines aren't sent to pages for sites that are gone.
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/top`, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/rank`, changeFrequency: "daily", priority: 0.6 },
    { url: `${BASE}/how`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${BASE}/removed`, changeFrequency: "weekly", priority: 0.3 },
  ];
  const hidden = await hiddenUrls().catch(() => new Set<string>());
  const detail: MetadataRoute.Sitemap = (feed as Portfolio[])
    .filter((p) => !hidden.has(p.url))
    .map((p) => ({
      url: `${BASE}/p/${encodeURIComponent(p.url)}`,
      changeFrequency: "weekly",
      priority: 0.5,
    }));
  return [...staticPages, ...detail];
}
