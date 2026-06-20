import type { MetadataRoute } from "next";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";

const BASE = "https://portfoliorank.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/top`, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/rank`, changeFrequency: "daily", priority: 0.6 },
  ];
  const detail: MetadataRoute.Sitemap = (feed as Portfolio[]).map((p) => ({
    url: `${BASE}/p/${encodeURIComponent(p.url)}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));
  return [...staticPages, ...detail];
}
