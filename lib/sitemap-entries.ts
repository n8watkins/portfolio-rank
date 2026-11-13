import { SITE_URL } from "@/lib/site";
import feed from "@/data/feed.json";
import { hiddenUrls } from "@/lib/roster";
import { db, ensureSchema } from "@/lib/db";
import { gradedProfiles, sitemapProfiles } from "@/lib/sitemap-profiles.mjs";
import { graderEnabled } from "@/lib/grader/server";
import { toolsEnabled } from "@/lib/tools/server";
import { publishedPosts } from "@/lib/blog-server";
import { tagsOf, tagSlug } from "@/lib/content/blog.mjs";
import { profilePath } from "@/lib/profile";
import { latest, type Entry } from "@/lib/sitemaps.mjs";

// What each part of the sitemap lists (lib/sitemaps.mjs builds the XML,
// app/sitemap.xml and app/sitemap/[part] serve it). Only pages meant to
// rank: reports (/grade/<id>), claims and personal pages are never listed.

const BASE = SITE_URL;

/** The site's own pages. Their content follows the day's data or a deploy, with no one time to give, so no lastmod. */
export function pageEntries(): Entry[] {
  return [
    BASE,
    `${BASE}/top`,
    // The old AI and People views lead to the ranked board while the ranking views (tiers by ELO) are on, and
    // don't exist while they are off: neither is listed.
    `${BASE}/browse`,
    `${BASE}/play`,
    `${BASE}/polls`,
    ...(graderEnabled() ? [`${BASE}/grade`] : []),
    // "Add your portfolio".
    ...(toolsEnabled() ? [`${BASE}/add`] : []),
    `${BASE}/how`,
    `${BASE}/grading`,
    `${BASE}/removed`,
    `${BASE}/about-posts`,
  ].map((url) => ({ url }));
}

/**
 * The blog: its list, every published post and every tag page, each with the
 * time its newest post changed (published, or edited after). A database
 * error throws, so the daily rebuild keeps yesterday's file.
 */
export async function blogEntries(): Promise<Entry[]> {
  const posts = await publishedPosts({ limit: 1000 });
  const changed = (p: (typeof posts)[number]) => latest(p.publishAt, p.updatedAt);
  return [
    { url: `${BASE}/blog`, lastmod: latest(...posts.map(changed)) },
    ...posts.map((p) => ({ url: `${BASE}/blog/${p.slug}`, lastmod: changed(p) })),
    ...tagsOf(posts).map((t: { slug: string }) => ({
      url: `${BASE}/blog/tag/${t.slug}`,
      lastmod: latest(...posts.filter((p) => p.tags.some((x) => tagSlug(x) === t.slug)).map(changed)),
    })),
  ];
}

/**
 * Profiles: only graded real portfolios the site shows (lib/sitemap-profiles.mjs),
 * in list order, each with the latest of its grade, screenshot and rating. A
 * database error throws, so the daily rebuild keeps yesterday's files instead
 * of publishing ones that list every ungraded site.
 */
export async function profileEntries(): Promise<Entry[]> {
  await ensureSchema();
  const [hidden, graded] = await Promise.all([hiddenUrls(), gradedProfiles(db())]);
  return sitemapProfiles(feed as { url: string }[], hidden, graded).map((url) => ({ url: `${BASE}${profilePath(url)}`, lastmod: graded.get(url) ?? null }));
}
