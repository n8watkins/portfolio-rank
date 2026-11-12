import { publishedPosts } from "@/lib/blog-server";
import { coverOf, imageSrc, postUrl } from "@/lib/blog";
import { SITE_URL } from "@/lib/site";

// The blog's RSS 2.0 feed: the 20 newest published posts. Rebuilt at most
// every 5 minutes (ISR), like the pages.
export const revalidate = 300;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export async function GET() {
  const posts = await publishedPosts({ limit: 20 });
  const items = posts.map((p) => {
    const cover = coverOf(p.images);
    return [
      "<item>",
      `<title>${esc(p.title)}</title>`,
      `<link>${postUrl(p.slug)}</link>`,
      `<guid isPermaLink="true">${postUrl(p.slug)}</guid>`,
      `<pubDate>${new Date(p.publishAt).toUTCString()}</pubDate>`,
      p.subtitle ? `<description>${esc(p.subtitle)}</description>` : "",
      ...p.tags.map((t) => `<category>${esc(t)}</category>`),
      cover ? `<enclosure url="${esc(new URL(imageSrc(p.id, cover), SITE_URL).toString())}" type="${cover.kind === "chart" ? "image/svg+xml" : "image/jpeg"}" length="0"/>` : "",
      "</item>",
    ]
      .filter(Boolean)
      .join("");
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    "<title>PortfolioRank blog</title>",
    `<link>${SITE_URL}/blog</link>`,
    `<atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml"/>`,
    "<description>Short posts from PortfolioRank's own data on what the best developer portfolios do.</description>",
    "<language>en</language>",
    posts[0] ? `<lastBuildDate>${new Date(posts[0].publishAt).toUTCString()}</lastBuildDate>` : "",
    ...items,
    "</channel>",
    "</rss>",
  ]
    .filter(Boolean)
    .join("\n");
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}
