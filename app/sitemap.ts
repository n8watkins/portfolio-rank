import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import feed from "@/data/feed.json";
import type { Portfolio } from "@/app/page";
import { hiddenUrls } from "@/lib/roster";
import { db, ensureSchema } from "@/lib/db";
import { gradedUrls, sitemapProfiles } from "@/lib/sitemap-profiles.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { rankingViewsEnabled } from "@/lib/leaderboard";
import { publishedPosts } from "@/lib/blog-server";
import { tagsOf } from "@/lib/content/blog.mjs";

const BASE = SITE_URL;

// Rebuilt once a day: sites the health check hides (down, dead or parked)
// drop out, so search engines aren't sent to pages for sites that are gone.
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/top`, changeFrequency: "daily", priority: 0.8 },
    // The AI and People views exist only while the ranking views are on.
    ...(rankingViewsEnabled()
      ? (["ai", "people"] as const).map((v) => ({ url: `${BASE}/top/${v}`, changeFrequency: "daily" as const, priority: 0.6 }))
      : []),
    { url: `${BASE}/browse`, changeFrequency: "daily", priority: 0.7 },
    { url: `${BASE}/play`, changeFrequency: "daily", priority: 0.6 },
    { url: `${BASE}/polls`, changeFrequency: "weekly", priority: 0.6 },
    // Reports (/grade/<id>) and claims are unlisted and never indexed.
    ...(graderEnabled() ? [{ url: `${BASE}/grade`, changeFrequency: "monthly" as const, priority: 0.7 }] : []),
    { url: `${BASE}/how`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${BASE}/grading`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${BASE}/removed`, changeFrequency: "weekly", priority: 0.3 },
  ];
  // The blog: the list, every published post and every tag page. Rebuilt
  // with the sitemap once a day, so a new post is listed by the next day.
  const posts = await publishedPosts({ limit: 1000 }).catch(() => []);
  const blog: MetadataRoute.Sitemap = [
    { url: `${BASE}/blog`, changeFrequency: "weekly", priority: 0.7, ...(posts[0] ? { lastModified: posts[0].publishAt } : {}) },
    ...posts.map((p) => ({ url: `${BASE}/blog/${p.slug}`, lastModified: p.publishAt, changeFrequency: "monthly" as const, priority: 0.6 })),
    ...tagsOf(posts).map((t: { slug: string }) => ({ url: `${BASE}/blog/tag/${t.slug}`, changeFrequency: "weekly" as const, priority: 0.3 })),
    { url: `${BASE}/about-posts`, changeFrequency: "monthly", priority: 0.3 },
  ];
  // Profiles: only graded real portfolios the site shows (lib/sitemap-profiles.mjs).
  // A database error throws, so the daily rebuild keeps yesterday's sitemap
  // instead of publishing one that lists every ungraded site.
  await ensureSchema();
  const hidden = await hiddenUrls();
  const graded = await gradedUrls(db());
  const detail: MetadataRoute.Sitemap = sitemapProfiles(feed as Portfolio[], hidden, graded).map((url) => ({
    url: `${BASE}/p/${encodeURIComponent(url)}`,
    changeFrequency: "weekly",
    priority: 0.5,
  }));
  return [...staticPages, ...blog, ...detail];
}
