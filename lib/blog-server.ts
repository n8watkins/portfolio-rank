import { db, ensureSchema } from "@/lib/db";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { getPublished, listPublished, morePosts } from "@/lib/content/blog.mjs";
import { type BlogListItem, type BlogPost, imageSrc } from "@/lib/blog";
import type { Related } from "@/components/blog/Article";

// The blog pages' database reads. The pages are rendered at most once every
// 5 minutes (ISR, the edge cache in front of them), so a post that goes live
// at its publish_at shows up within 5 minutes and anonymous visitors cost no
// database read in between.

export async function publishedPosts(opts: { tag?: string | null; limit?: number } = {}): Promise<BlogListItem[]> {
  await ensureSchema();
  return (await listPublished(db(), { now: new Date(), limit: opts.limit ?? 50, tag: opts.tag ?? null })) as BlogListItem[];
}

export async function publishedPost(slug: string): Promise<BlogPost | null> {
  await ensureSchema();
  return (await getPublished(db(), slug, { now: new Date() })) as BlogPost | null;
}

/** "More articles" under a post: related by tag first, then the newest (lib/content/blog.mjs morePosts). */
export async function moreArticles(post: { id: string; tags: string[] }, limit = 3): Promise<BlogListItem[]> {
  const posts = await publishedPosts({ limit: 50 });
  return morePosts(post, posts, { limit }) as BlogListItem[];
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The portfolios a post names (its fact sheet's allowed names, positive by
 * the naming rule) that the text actually mentions, with a thumbnail.
 */
export async function relatedPortfolios(post: BlogPost): Promise<Related[]> {
  const text = `${post.title}\n${post.body}`;
  // The post's own screenshots of a named site double as its thumbnail.
  const shots = new Map(post.images.filter((im) => im.kind === "screenshot" && im.creditUrl).map((im) => [im.creditUrl!, imageSrc(post.id, im)]));
  const names = (post.facts?.names ?? []).filter((n) => n.url && (shots.has(n.url) || text.includes(n.name) || (n.domain && text.includes(n.domain))));
  if (!names.length) return [];
  const bases = await shotBases(names.map((n) => n.url!)).catch(() => new Map<string, string>());
  return names.map((n) => {
    const base = bases.get(n.url!);
    return { name: n.name, url: n.url!, domain: n.domain ?? domainOf(n.url!), reason: n.reason, shot: shots.get(n.url!) ?? (base ? heroOf(base) : mshotsUrl(n.url!, 400)) };
  });
}
